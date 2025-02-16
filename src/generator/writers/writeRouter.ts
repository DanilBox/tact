import { beginCell } from "@ton/core";
import { getType } from "../../types/resolveDescriptors";
import { ReceiverDescription, TypeDescription } from "../../types/types";
import { WriterContext } from "../Writer";
import { funcIdOf } from "./id";
import { ops } from "./ops";
import { resolveFuncType } from "./resolveFuncType";
import { resolveFuncTypeUnpack } from "./resolveFuncTypeUnpack";
import { writeStatement } from "./writeFunction";
import { AstNumber, AstReceiver } from "../../ast/ast";
import { throwCompilationError } from "../../error/errors";

export function commentPseudoOpcode(comment: string, ast: AstReceiver): string {
    const buffer = Buffer.from(comment, "utf8");
    if (buffer.length > 123) {
        throwCompilationError(
            `receiver message is too long, max length is 123 bytes, but given ${buffer.length}`,
            ast.loc,
        );
    }

    return beginCell()
        .storeUint(0, 32)
        .storeBuffer(buffer)
        .endCell()
        .hash()
        .toString("hex", 0, 64);
}

export function writeRouter(
    type: TypeDescription,
    kind: "internal" | "external",
    ctx: WriterContext,
) {
    const internal = kind === "internal";
    if (internal) {
        ctx.append(
            `(${resolveFuncType(type, ctx)}, int) ${ops.contractRouter(type.name, kind)}(${resolveFuncType(type, ctx)} self, slice in_msg, int msg_bounced) impure inline_ref {`,
        );
    } else {
        ctx.append(
            `(${resolveFuncType(type, ctx)}, int) ${ops.contractRouter(type.name, kind)}(${resolveFuncType(type, ctx)} self, slice in_msg) impure inline_ref {`,
        );
    }
    ctx.inIndent(() => {
        // Handle bounced
        if (internal) {
            ctx.append(`;; Handle bounced messages`);
            ctx.append(`if (msg_bounced) {`);
            ctx.inIndent(() => {
                const bounceReceivers = type.receivers.filter((r) => {
                    return r.selector.kind === "bounce-binary";
                });

                const fallbackReceiver = type.receivers.find((r) => {
                    return r.selector.kind === "bounce-fallback";
                });

                if (fallbackReceiver ?? bounceReceivers.length > 0) {
                    ctx.append();
                    ctx.append(`;; Skip 0xFFFFFFFF`);
                    ctx.append(`in_msg~skip_bits(32);`);
                    ctx.append();
                }

                if (bounceReceivers.length > 0) {
                    ctx.append(`;; Parse op`);
                    ctx.append(`int op = 0;`);
                    ctx.append(`if (slice_bits(in_msg) >= 32) {`);
                    ctx.inIndent(() => {
                        ctx.append(`op = in_msg.preload_uint(32);`);
                    });
                    ctx.append(`}`);
                    ctx.append();
                }

                for (const r of bounceReceivers) {
                    const selector = r.selector;
                    if (selector.kind !== "bounce-binary")
                        throw Error("Invalid selector type: " + selector.kind); // Should not happen
                    const allocation = getType(ctx.ctx, selector.type);
                    ctx.append(
                        `;; Bounced handler for ${selector.type} message`,
                    );
                    ctx.append(
                        `if (op == ${messageOpcode(allocation.header!)}) {`,
                    );
                    ctx.inIndent(() => {
                        // Read message
                        ctx.append(
                            `var msg = in_msg~${selector.bounced ? ops.readerBounced(selector.type, ctx) : ops.reader(selector.type, ctx)}();`,
                        );

                        // Execute function
                        ctx.append(
                            `self~${ops.receiveTypeBounce(type.name, selector.type)}(msg);`,
                        );

                        // Exit
                        ctx.append("return (self, true);");
                    });
                    ctx.append(`}`);
                    ctx.append();
                }

                if (fallbackReceiver) {
                    const selector = fallbackReceiver.selector;
                    if (selector.kind !== "bounce-fallback")
                        throw Error("Invalid selector type: " + selector.kind);

                    // Execute function
                    ctx.append(`;; Fallback bounce receiver`);
                    ctx.append(
                        `self~${ops.receiveBounceAny(type.name)}(in_msg);`,
                    );
                    ctx.append();

                    // Exit
                    ctx.append("return (self, true);");
                } else {
                    ctx.append(`return (self, true);`);
                }
            });
            ctx.append(`}`);
        }

        // Parse incoming message
        ctx.append();
        ctx.append(`;; Parse incoming message`);
        ctx.append(`int op = 0;`);
        ctx.append(`if (slice_bits(in_msg) >= 32) {`);
        ctx.inIndent(() => {
            ctx.append(`op = in_msg.preload_uint(32);`);
        });
        ctx.append(`}`);
        ctx.append();

        // Non-empty receivers
        for (const f of type.receivers) {
            const selector = f.selector;

            // Generic receiver
            if (
                selector.kind ===
                (internal ? "internal-binary" : "external-binary")
            ) {
                const allocation = getType(ctx.ctx, selector.type);
                if (!allocation.header) {
                    throw Error("Invalid allocation: " + selector.type);
                }
                ctx.append();
                ctx.append(`;; Receive ${selector.type} message`);
                ctx.append(`if (op == ${messageOpcode(allocation.header)}) {`);
                ctx.inIndent(() => {
                    // Read message
                    ctx.append(
                        `var msg = in_msg~${ops.reader(selector.type, ctx)}();`,
                    );

                    // Execute function
                    ctx.append(
                        `self~${ops.receiveType(type.name, kind, selector.type)}(msg);`,
                    );

                    // Exit
                    ctx.append("return (self, true);");
                });
                ctx.append(`}`);
            }

            if (
                selector.kind ===
                (internal ? "internal-empty" : "external-empty")
            ) {
                ctx.append();
                ctx.append(`;; Receive empty message`);
                ctx.append(`if ((op == 0) & (slice_bits(in_msg) <= 32)) {`);
                ctx.inIndent(() => {
                    // Execute function
                    ctx.append(`self~${ops.receiveEmpty(type.name, kind)}();`);

                    // Exit
                    ctx.append("return (self, true);");
                });
                ctx.append(`}`);
            }
        }

        // Text resolvers
        const hasComments = !!type.receivers.find((v) =>
            internal
                ? v.selector.kind === "internal-comment" ||
                  v.selector.kind === "internal-comment-fallback"
                : v.selector.kind === "external-comment" ||
                  v.selector.kind === "external-comment-fallback",
        );
        if (hasComments) {
            ctx.append();
            ctx.append(`;; Text Receivers`);
            ctx.append(`if (op == 0) {`);
            ctx.inIndent(() => {
                if (
                    type.receivers.find(
                        (v) =>
                            v.selector.kind ===
                            (internal
                                ? "internal-comment"
                                : "external-comment"),
                    )
                ) {
                    ctx.append(`var text_op = slice_hash(in_msg);`);
                    for (const r of type.receivers) {
                        const selector = r.selector;
                        if (
                            selector.kind ===
                            (internal ? "internal-comment" : "external-comment")
                        ) {
                            const hash = commentPseudoOpcode(
                                selector.comment,
                                r.ast,
                            );
                            ctx.append();
                            ctx.append(
                                `;; Receive "${selector.comment}" message`,
                            );
                            ctx.append(`if (text_op == 0x${hash}) {`);
                            ctx.inIndent(() => {
                                // Execute function
                                ctx.append(
                                    `self~${ops.receiveText(type.name, kind, hash)}();`,
                                );

                                // Exit
                                ctx.append("return (self, true);");
                            });
                            ctx.append(`}`);
                        }
                    }
                }

                // Comment fallback resolver
                const fallback = type.receivers.find(
                    (v) =>
                        v.selector.kind ===
                        (internal
                            ? "internal-comment-fallback"
                            : "external-comment-fallback"),
                );
                if (fallback) {
                    ctx.append(`if (slice_bits(in_msg) >= 32) {`);
                    ctx.inIndent(() => {
                        // Execute function
                        ctx.append(
                            `self~${ops.receiveAnyText(type.name, kind)}(in_msg.skip_bits(32));`,
                        );

                        // Exit
                        ctx.append("return (self, true);");
                    });

                    ctx.append(`}`);
                }
            });
            ctx.append(`}`);
        }

        // Fallback
        const fallbackReceiver = type.receivers.find(
            (v) =>
                v.selector.kind ===
                (internal ? "internal-fallback" : "external-fallback"),
        );
        if (fallbackReceiver) {
            ctx.append();
            ctx.append(`;; Receiver fallback`);

            // Execute function
            ctx.append(`self~${ops.receiveAny(type.name, kind)}(in_msg);`);

            ctx.append("return (self, true);");
        } else {
            ctx.append();
            ctx.append("return (self, false);");
        }
    });
    ctx.append(`}`);
    ctx.append();
}

function messageOpcode(n: AstNumber): string {
    // FunC does not support binary and octal numerals
    switch (n.base) {
        case 10:
            return n.value.toString(n.base);
        case 2:
        case 8:
        case 16:
            return `0x${n.value.toString(n.base)}`;
    }
}

export function writeReceiver(
    self: TypeDescription,
    f: ReceiverDescription,
    ctx: WriterContext,
) {
    const selector = f.selector;
    const selfRes = resolveFuncTypeUnpack(self, funcIdOf("self"), ctx);
    const selfType = resolveFuncType(self, ctx);
    const selfUnpack = `var ${resolveFuncTypeUnpack(self, funcIdOf("self"), ctx)} = ${funcIdOf("self")};`;

    // Binary receiver
    if (
        selector.kind === "internal-binary" ||
        selector.kind === "external-binary"
    ) {
        const args = [
            selfType + " " + funcIdOf("self"),
            resolveFuncType(selector.type, ctx) + " " + funcIdOf(selector.name),
        ];
        ctx.append(
            `((${selfType}), ()) ${ops.receiveType(self.name, selector.kind === "internal-binary" ? "internal" : "external", selector.type)}(${args.join(", ")}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);
            ctx.append(
                `var ${resolveFuncTypeUnpack(selector.type, funcIdOf(selector.name), ctx)} = ${funcIdOf(selector.name)};`,
            );

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }

    // Empty receiver
    if (
        selector.kind === "internal-empty" ||
        selector.kind === "external-empty"
    ) {
        ctx.append(
            `((${selfType}), ()) ${ops.receiveEmpty(self.name, selector.kind === "internal-empty" ? "internal" : "external")}(${selfType + " " + funcIdOf("self")}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }

    // Comment receiver
    if (
        selector.kind === "internal-comment" ||
        selector.kind === "external-comment"
    ) {
        const hash = commentPseudoOpcode(selector.comment, f.ast);
        ctx.append(
            `(${selfType}, ()) ${ops.receiveText(self.name, selector.kind === "internal-comment" ? "internal" : "external", hash)}(${selfType + " " + funcIdOf("self")}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }

    // Fallback
    if (
        selector.kind === "internal-comment-fallback" ||
        selector.kind === "external-comment-fallback"
    ) {
        ctx.append(
            `(${selfType}, ()) ${ops.receiveAnyText(self.name, selector.kind === "internal-comment-fallback" ? "internal" : "external")}(${[selfType + " " + funcIdOf("self"), "slice " + funcIdOf(selector.name)].join(", ")}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }

    // Fallback
    if (selector.kind === "internal-fallback") {
        ctx.append(
            `(${selfType}, ()) ${ops.receiveAny(self.name, "internal")}(${selfType} ${funcIdOf("self")}, slice ${funcIdOf(selector.name)}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }

    // Bounced
    if (selector.kind === "bounce-fallback") {
        ctx.append(
            `(${selfType}, ()) ${ops.receiveBounceAny(self.name)}(${selfType} ${funcIdOf("self")}, slice ${funcIdOf(selector.name)}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }

    if (selector.kind === "bounce-binary") {
        const args = [
            selfType + " " + funcIdOf("self"),
            resolveFuncType(selector.type, ctx, false, selector.bounced) +
                " " +
                funcIdOf(selector.name),
        ];
        ctx.append(
            `((${selfType}), ()) ${ops.receiveTypeBounce(self.name, selector.type)}(${args.join(", ")}) impure inline {`,
        );
        ctx.inIndent(() => {
            ctx.append(selfUnpack);
            ctx.append(
                `var ${resolveFuncTypeUnpack(selector.type, funcIdOf(selector.name), ctx, false, selector.bounced)} = ${funcIdOf(selector.name)};`,
            );

            for (const s of f.ast.statements) {
                writeStatement(s, selfRes, null, ctx);
            }

            if (
                f.ast.statements.length === 0 ||
                f.ast.statements[f.ast.statements.length - 1]!.kind !==
                    "statement_return"
            ) {
                ctx.append(`return (${selfRes}, ());`);
            }
        });
        ctx.append(`}`);
        ctx.append();
        return;
    }
}
