import assert from "node:assert";
import test, { suite } from "node:test";
import * as os from "../../core/internal/bundle/lib/os/index.ts";
import nodeOs from "node:os";
import nodeFs from "node:fs";
import nodePath from "node:path";

suite("os - e2e", () => {
    test("platform", () => {
        assert.deepEqual(os.platform(), nodeOs.platform());
    });

    test("endianess", () => {
        assert.deepEqual(os.endianness(), nodeOs.endianness());
    });

    test("uname", () => {
        assert.deepEqual(os.release(), nodeOs.release());
        assert.deepEqual(os.type(), nodeOs.type());
    });

    test("hostname", () => {
        assert.deepEqual(os.hostname(), nodeOs.hostname());
    });

    test("tmpdir", () => {
        const tmp = os.tmpdir();
        assert.strictEqual(
            tmp,
            "/.tmp",
            "tmpdir should be relative to context root directory"
        );
        assert.ok(
            nodeFs.existsSync(nodePath.join(process.cwd(), tmp)),
            ".tmp directory should exist"
        );
        assert.ok(
            nodeFs.statSync(nodePath.join(process.cwd(), tmp)).isDirectory(),
            ".tmp should be a directory"
        );
    });
});
