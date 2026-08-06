import test, { suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { staticFileResolve } from "../../platform/node/src/index.ts";

suite("static-file - e2e", () => {
    test("index.html", () => {
        const staticFile = staticFileResolve(0, "test/static-file/sample");
        assert.deepEqual(staticFile, {
            found: true,
            mimeType: "text/html; charset=utf-8",
            data: fs.readFileSync("test/static-file/sample/index.html")
        });
    });
    test("index.ts", () => {
        const staticFile = staticFileResolve(
            0,
            "test/static-file/sample/out/index.ts.js"
        );
        assert.deepEqual(staticFile, {
            found: true,
            mimeType: "text/javascript; charset=utf-8",
            data: fs.readFileSync("test/static-file/sample/out/index.ts.js")
        });
    });
});
