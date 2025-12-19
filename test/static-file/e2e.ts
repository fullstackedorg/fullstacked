import test, { suite } from "node:test";
import assert from "node:assert";
import core from "../core.ts";
import { coreStaticFile } from "../../platform/node/src/webview.ts";
import fs from "node:fs";

suite("static-file - e2e", () => {
    test("index.html", () => {
        const staticFile = coreStaticFile(
            core.instance,
            0,
            "test/static-file/sample"
        );
        assert.deepEqual(staticFile, {
            found: true,
            mimeType: "text/html; charset=utf-8",
            data: fs.readFileSync("test/static-file/sample/index.html")
        });
    });
    test("index.ts", () => {
        const staticFile = coreStaticFile(
            core.instance,
            0,
            "test/static-file/sample/index.ts"
        );
        assert.deepEqual(staticFile, {
            found: true,
            mimeType: "text/javascript; charset=utf-8",
            data: fs.readFileSync("test/static-file/sample/_index.ts.js")
        });
    });
});
