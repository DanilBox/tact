import fs from "fs";
import { join } from "path";
import { AstRenamer } from "../ast/rename";
import { prettyPrint } from "../ast/ast-printer";
import { trimTrailingCR, CONTRACTS_DIR } from "./util";
import * as assert from "assert";
import { getParser } from "../grammar";
import { getAstFactory } from "../ast/ast-helpers";
import { defaultParser } from "../grammar/grammar";

const EXPECTED_DIR = join(CONTRACTS_DIR, "renamer-expected");

describe("renamer", () => {
    it.each(fs.readdirSync(CONTRACTS_DIR, { withFileTypes: true }))(
        "should have an expected content after being renamed",
        (dentry) => {
            if (!dentry.isFile()) {
                return;
            }
            const ast = getAstFactory();
            const { parse } = getParser(ast, defaultParser);
            const expectedFilePath = join(EXPECTED_DIR, dentry.name);
            const expected = fs.readFileSync(expectedFilePath, "utf-8");
            const path = join(CONTRACTS_DIR, dentry.name);
            const code = fs.readFileSync(path, "utf-8");
            const inAst = parse({ code, path, origin: "user" });
            const outAst = AstRenamer.make().renameModule(inAst);
            const got = prettyPrint(outAst);
            assert.strictEqual(
                trimTrailingCR(got),
                trimTrailingCR(expected),
                `AST comparison after renamed failed for ${dentry.name}`,
            );
        },
    );
});
