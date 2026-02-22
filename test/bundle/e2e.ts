import test, { suite, afterEach, before } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import child_process from "node:child_process";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { tailwindcssBuilder, cleanup } from "./common.ts";

suite("bundle - e2e", () => {
    before(cleanup);
    afterEach(cleanup);

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
            "test/bundle/samples/basic/index.ts"
        );
        assert.deepEqual(errorsAndWarnings.Errors, null);
        assert.deepEqual(errorsAndWarnings.Warnings, null);
        assert.ok(fs.existsSync("test/bundle/samples/basic/_index.ts.js"));
    });

    test("bundle - css", async () => {
        const errorsAndWarnings = await bundle.bundle(
            "test/bundle/samples/css/index.ts"
        );
        assert.deepEqual(errorsAndWarnings.Errors, null);
        assert.deepEqual(errorsAndWarnings.Warnings, null);
        assert.ok(fs.existsSync("test/bundle/samples/css/_index.ts.js"));
        assert.ok(fs.existsSync("test/bundle/samples/css/_index.ts.css"));
    });

    test("bundle - tailwindcss", async () => {
        child_process.execSync("npx tailwindcss -i index.css -o output.css", {
            stdio: "ignore",
            cwd: "test/bundle/samples/tailwindcss"
        });

        const builder = await tailwindcssBuilder();

        await bundle.bundle("test/bundle/samples/tailwindcss/index.ts");

        assert.deepEqual(
            fs.readFileSync(
                "test/bundle/samples/tailwindcss/_index.ts.tailwind.css"
            ),
            fs.readFileSync("test/bundle/samples/tailwindcss/output.css")
        );
        builder.end();
    });
});
