import test, { before, suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { staticFileResolve } from "../../platform/node/src/index.ts";
import run from "../../core/internal/bundle/lib/run/index.ts";

suite("static-file - e2e", () => {
    test("index.html", () => {
        const staticFile = staticFileResolve(0, "test/static-file/sample");
        assert.deepEqual(staticFile, {
            found: true,
            mimeType: "text/html; charset=utf-8",
            data: fs.readFileSync("test/static-file/sample/index.html")
        });
    });
    test("index.ts", () => {
        const staticFile = staticFileResolve(
            0,
            "test/static-file/sample/out/index.ts.js"
        );
        assert.deepEqual(staticFile, {
            found: true,
            mimeType: "text/javascript; charset=utf-8",
            data: fs.readFileSync("test/static-file/sample/out/index.ts.js")
        });
    });

    suite("sample project", () => {
        let ctx: number;

        before(async () => {
            ctx = await run("test/static-file/sample");
        });

        test("directory index.html", () => {
            for (const pathname of ["/script", "/script/"]) {
                assert.deepEqual(staticFileResolve(ctx, pathname), {
                    found: true,
                    mimeType: "text/html; charset=utf-8",
                    data: fs.readFileSync(
                        "test/static-file/sample/script/index.html"
                    )
                });
            }
        });

        test("../ staying inside the project", () => {
            for (const pathname of [
                "/script/../index.html",
                "/script%2F..%2Findex.html"
            ]) {
                assert.deepEqual(staticFileResolve(ctx, pathname), {
                    found: true,
                    mimeType: "text/html; charset=utf-8",
                    data: fs.readFileSync("test/static-file/sample/index.html")
                });
            }
        });

        // test/static-file/e2e.ts (this file) is right above the project
        const outside = [
            "/../e2e.ts",
            "/..%2Fe2e.ts",
            "/%2E%2E%2Fe2e.ts",
            "/script/../../e2e.ts",
            "/script%2F..%2F..%2Fe2e.ts",
            "/out/../../e2e.ts",
            "/..%2F..%2Fstatic-file%2Fe2e.ts",
            "/..\\e2e.ts",
            "/..%5Ce2e.ts",
            "/script%5C..%5C..%5Ce2e.ts",
            "/..",
            "/../",
            "/" + path.resolve("test/static-file/e2e.ts"),
            "/" + encodeURIComponent(path.resolve("test/static-file/e2e.ts"))
        ];
        for (const pathname of outside) {
            test(`outside of the project: ${pathname}`, () => {
                assert.equal(staticFileResolve(ctx, pathname).found, false);
            });
        }
    });
});
