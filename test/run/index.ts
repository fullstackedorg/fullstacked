// core Run: a context only starts contexts in its own root or a directory
// under it, whatever path reaches the core (fullstacked/run resolves it first,
// a raw bridge call doesn't)
import assert from "node:assert";
import test, { suite } from "node:test";
import run from "../../core/internal/bundle/lib/run/index.ts";
import { Core } from "../../core/internal/bundle/lib/@types/index.ts";
import { Run } from "../../core/internal/bundle/lib/@types/router.ts";

function rawRun(directory: string) {
    return globalThis.fullstacked.bridge({
        mod: Core,
        fn: Run,
        data: [directory, {}, false]
    }) as Promise<number>;
}

suite("run - contexts under the caller's root", () => {
    test("starts a context in the root or a directory under it", async () => {
        assert.strictEqual(typeof (await run(".")), "number");
        assert.strictEqual(typeof (await run("test/run")), "number");
        assert.strictEqual(typeof (await rawRun("/test/run")), "number");
        assert.strictEqual(typeof (await rawRun("test/../test/run")), "number");
    });

    test("fullstacked/run resolves .. at the root", async () => {
        // path.resolve stops at the virtual root: the context starts in the root
        assert.strictEqual(typeof (await run("../..")), "number");
    });

    test("refuses a directory outside the root", async () => {
        for (const directory of ["..", "../other", "/../other", "test/../../.."]) {
            await assert.rejects(rawRun(directory), /outside the context's root/, directory);
        }
    });
});
