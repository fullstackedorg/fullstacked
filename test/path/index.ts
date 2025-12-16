import test, { suite } from "node:test";
import assert from "node:assert";
import * as path from "../../lib/path/index.ts";
import * as nodePath from "node:path";

suite("path - e2e", () => {
    test("join", () => {
        assert.deepEqual(
            path.join("test", ".", "dir", "..", "file.txt"),
            nodePath.join("test", ".", "dir", "..", "file.txt")
        );
    });

    test("resolve", () => {
        assert.deepEqual(path.resolve("."), nodePath.resolve("."));
    });

    test("normalize", () => {
        assert.deepEqual(
            path.normalize("platform/.././node/package.json"),
            nodePath.normalize("platform/.././node/package.json")
        );
    });

    test("parse", () => {
        assert.deepEqual(
            path.parse("./platform/node/package.json"),
            nodePath.parse("./platform/node/package.json")
        );
        assert.deepEqual(
            path.parse("./platform/node"),
            nodePath.parse("./platform/node")
        );
        assert.deepEqual(
            path.parse("/platform/node/package.json"),
            nodePath.parse("/platform/node/package.json")
        );
        assert.deepEqual(
            path.parse("platform/.././node/package.json"),
            nodePath.parse("platform/.././node/package.json")
        );
    });

    test("extname", () => {
        assert.deepEqual(
            path.extname("index.html"),
            nodePath.extname("index.html")
        );
        assert.deepEqual(
            path.extname("index.coffee.md"),
            nodePath.extname("index.coffee.md")
        );
        assert.deepEqual(path.extname("index."), nodePath.extname("index."));
        assert.deepEqual(path.extname("index"), nodePath.extname("index"));
        assert.deepEqual(
            path.extname(".index.md"),
            nodePath.extname(".index.md")
        );
    });

    test("dirname", () => {
        assert.deepEqual(
            path.dirname("/foo/bar/baz/asdf/quux"),
            nodePath.dirname("/foo/bar/baz/asdf/quux")
        );
    });

    test("basename", () => {
        assert.deepEqual(
            path.basename("/foo/bar/baz/asdf/quux.html"),
            nodePath.basename("/foo/bar/baz/asdf/quux.html")
        );
        assert.deepEqual(
            path.basename("/foo/bar/baz/asdf/quux.html", ".html"),
            nodePath.basename("/foo/bar/baz/asdf/quux.html", ".html")
        );
    });

    test("relative", () => {
        assert.deepEqual(
            path.relative("/data/orandea/test/aaa", "/data/orandea/impl/bbb"),
            nodePath.relative(
                "/data/orandea/test/aaa",
                "/data/orandea/impl/bbb"
            )
        );
    });
});
