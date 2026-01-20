import assert from "node:assert";
import test, { suite } from "node:test";
import * as os from "../../core/internal/bundle/lib/os/index.ts";
import nodeOs from "node:os";

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
});
