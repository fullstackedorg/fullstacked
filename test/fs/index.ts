import test, { suite } from "node:test";
import assert from "node:assert";
import * as fs from "../../lib/fs/index.ts";
import * as nodeFs from "node:fs";

suite("fs - e2e", () => {
    test("exists", () => {
        assert.deepEqual(
            fs.existsSync("package.json"),
            nodeFs.existsSync("package.json")
        );
        assert.deepEqual(
            fs.existsSync("not-exists"),
            nodeFs.existsSync("not-exists")
        );
    });

    // test("readFile", () => {

    //     assert.deepEqual(fs.readFile("package.json"), nodeFs.readFile("package.json"));
    // });
});
