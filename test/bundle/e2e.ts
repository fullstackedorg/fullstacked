import test, { suite, afterEach, before } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { cleanup } from "./common.ts";

suite("bundle - e2e", () => {
    before(cleanup);
    afterEach(cleanup);

    test("esbuild version", async () => {
        const packageJson = JSON.parse(
            await fs.promises.readFile("package.json", { encoding: "utf-8" })
        );
        const esbuildVersionJS = packageJson.devDependencies.esbuild.replace(
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
});
