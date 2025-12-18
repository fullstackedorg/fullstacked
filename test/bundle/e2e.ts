import test, { before, after, suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";

const cleanupBundledFiles = () => {
    const sampleDir = "test/bundle/sample";
    fs.readdirSync(sampleDir)
        .filter((f) => f.startsWith("_"))
        .forEach((f) => fs.rmSync(path.join(sampleDir, f)));
};

suite("bundle - e2e", () => {
    before(() => {
        cleanupBundledFiles();
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

    test("bundle", async () => {
        const errorsAndWarnings = await bundle.bundle(
            Node,
            "test/bundle/sample/index.ts"
        );
        assert.deepEqual(errorsAndWarnings.Errors, null);
        assert.deepEqual(errorsAndWarnings.Warnings, null);
        assert.ok(fs.existsSync("test/bundle/sample/_index.ts.js"));
    });

    after(() => {
        cleanupBundledFiles();
    });
});
