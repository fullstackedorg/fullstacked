import test, { before, after, suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";
import { cleanupBundledFiles } from "./utils.ts";

suite("bundle - e2e", () => {
    before(() => {
        cleanupBundledFiles("test/bundle/samples");
    });

    test("esbuild version", async () => {
        const packageJson = JSON.parse(
            await fs.promises.readFile("package.json", { encoding: "utf-8" })
        );
        const esbuildVersionJS = packageJson.dependencies.esbuild.replace(
            "^",
            "v"
        );
        assert.deepEqual(await bundle.esbuildVersion(), esbuildVersionJS);
    });

    test("bundle - ts", async () => {
        const errorsAndWarnings = await bundle.bundle(
            Node,
            "test/bundle/samples/basic/index.ts"
        );
        assert.deepEqual(errorsAndWarnings.Errors, null);
        assert.deepEqual(errorsAndWarnings.Warnings, null);
        assert.ok(fs.existsSync("test/bundle/samples/basic/_index.ts.js"));
    });

    test("bundle - css", async () => {
        const errorsAndWarnings = await bundle.bundle(
            Node,
            "test/bundle/samples/css/index.ts"
        );
        assert.deepEqual(errorsAndWarnings.Errors, null);
        assert.deepEqual(errorsAndWarnings.Warnings, null);
        assert.ok(fs.existsSync("test/bundle/samples/css/_index.ts.js"));
        assert.ok(fs.existsSync("test/bundle/samples/css/_index.ts.css"));
    });
});
