import test, { before, after, suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import * as bundle from "../../lib/bundle/index.ts";

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
            "./test/bundle/sample/index.ts"
        );
        assert.ok(errorsAndWarnings.Errors === null);
        assert.ok(errorsAndWarnings.Warnings === null);
        assert.ok(fs.existsSync("./test/bundle/sample/_index.ts.js"));
    });

    after(() => {
        cleanupBundledFiles();
    });
});
