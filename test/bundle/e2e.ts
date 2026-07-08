import test, { suite, afterEach, before } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { tailwindcssBuilder, cleanup, sassBuilder } from "./common.ts";

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

    test("bundle - file", async () => {
        const result = await bundle.bundleFile(
            "test/bundle/samples/file/index.ts"
        );
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        assert.deepEqual(result.OutputFiles, [
            path.join("test", "bundle", "samples", "file", "index.ts.js")
        ]);
        assert.ok(fs.existsSync(result.OutputFiles.at(0)));
    });

    test("bundle - ts", async () => {
        const result = await bundle.bundle(
            "test/bundle/samples/basic/index.ts"
        );
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        assert.deepEqual(result.OutputFiles, [
            path.join(
                "test",
                "bundle",
                "samples",
                "basic",
                "out",
                "index.ts.js"
            ),
            path.join("test", "bundle", "samples", "basic", "out", "index.html")
        ]);
        assert.ok(fs.existsSync("test/bundle/samples/basic/out/index.ts.js"));
    });

    test("bundle - css", async () => {
        const result = await bundle.bundle("test/bundle/samples/css/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        assert.deepEqual(result.OutputFiles, [
            path.join("test", "bundle", "samples", "css", "out", "index.ts.js"),
            path.join(
                "test",
                "bundle",
                "samples",
                "css",
                "out",
                "index.ts.css"
            ),
            path.join("test", "bundle", "samples", "css", "out", "index.html")
        ]);
        assert.ok(fs.existsSync("test/bundle/samples/css/out/index.ts.js"));
        assert.ok(fs.existsSync("test/bundle/samples/css/out/index.ts.css"));
    });

    test("bundle - tailwindcss", async () => {
        child_process.execSync("npx tailwindcss -i index.css -o output.css", {
            stdio: "ignore",
            cwd: "test/bundle/samples/tailwindcss"
        });

        const builder = await tailwindcssBuilder();

        const result = await bundle.bundle("test/bundle/samples/tailwindcss");

        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);

        assert.deepEqual(result.OutputFiles, [
            path.join(
                "test",
                "bundle",
                "samples",
                "tailwindcss",
                "out",
                "index.ts.js"
            ),
            path.join(
                "test",
                "bundle",
                "samples",
                "tailwindcss",
                "out",
                "index.ts.css"
            ),
            path.join(
                "test",
                "bundle",
                "samples",
                "tailwindcss",
                "out",
                "index.css.tailwind.css"
            ),
            path.join(
                "test",
                "bundle",
                "samples",
                "tailwindcss",
                "out",
                "index.html"
            )
        ]);

        assert.deepEqual(
            fs.readFileSync(
                "test/bundle/samples/tailwindcss/out/index.css.tailwind.css"
            ),
            fs.readFileSync("test/bundle/samples/tailwindcss/output.css")
        );
        builder.end();
    });

    test("bundle - sass", async () => {
        child_process.execSync(
            "npx sass style.scss output.css --no-source-map",
            {
                stdio: "ignore",
                cwd: "test/bundle/samples/sass"
            }
        );

        const builder = await sassBuilder();

        const result = await bundle.bundle("test/bundle/samples/sass/index.ts");

        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);

        assert.deepEqual(result.OutputFiles, [
            path.join(
                "test",
                "bundle",
                "samples",
                "sass",
                "out",
                "index.ts.js"
            ),
            path.join(
                "test",
                "bundle",
                "samples",
                "sass",
                "out",
                "style.scss.css"
            ),
            path.join("test", "bundle", "samples", "sass", "out", "index.html")
        ]);

        assert.deepEqual(
            fs.readFileSync("test/bundle/samples/sass/out/style.scss.css"),
            fs.readFileSync("test/bundle/samples/sass/output.css")
        );
        builder.end();
    });
});
