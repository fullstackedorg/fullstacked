import test, { suite } from "node:test";
import assert from "node:assert";
import * as path from "../../lib/path/index.ts";
import * as nodePath from "node:path";

suite("path - e2e", () => {
    test("join", () => {
        assert.deepEqual(
            path.join("test", ".", "dir", "..", "file.txt"),
            nodePath.join("test", ".", "dir", "..", "file.txt")
        );
    });

    test("resolve", () => {
        assert.deepEqual(path.resolve("."), nodePath.resolve("."));
    });

    // test("readFile", () => {

    //     assert.deepEqual(fs.readFile("package.json"), nodeFs.readFile("package.json"));
    // });
});
