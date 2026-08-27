import test, { suite } from "node:test";
import assert from "node:assert";
import * as path from "../../core/internal/bundle/lib/path/index.ts";
import * as nodePath from "node:path";

suite("path - e2e", () => {
    test("join", () => {
        assert.deepEqual(
            path.join("test", ".", "dir", "..", "file.txt"),
            nodePath.join("test", ".", "dir", "..", "file.txt")
        );
    });

    test("resolve", () => {
        assert.deepEqual(path.resolve("."), nodePath.sep);
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
        assert.deepEqual(
            path.parse("/"),
            nodePath.posix.parse("/")
        );
        assert.deepEqual(
            path.parse(""),
            nodePath.posix.parse("")
        );
        assert.deepEqual(
            path.parse("/foo"),
            nodePath.posix.parse("/foo")
        );
        assert.deepEqual(
            path.parse("foo"),
            nodePath.posix.parse("foo")
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
        assert.deepEqual(path.extname("/"), nodePath.posix.extname("/"));
        assert.deepEqual(path.extname(""), nodePath.posix.extname(""));
    });

    test("dirname", () => {
        assert.deepEqual(
            path.dirname("/foo/bar/baz/asdf/quux"),
            nodePath.dirname("/foo/bar/baz/asdf/quux")
        );
        assert.deepEqual(
            path.dirname("/foo"),
            nodePath.posix.dirname("/foo")
        );
        assert.deepEqual(
            path.dirname("/"),
            nodePath.posix.dirname("/")
        );
        assert.deepEqual(
            path.dirname(""),
            nodePath.posix.dirname("")
        );
        assert.deepEqual(
            path.dirname("foo"),
            nodePath.posix.dirname("foo")
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
        assert.deepEqual(
            path.basename("/"),
            nodePath.posix.basename("/")
        );
        assert.deepEqual(
            path.basename(""),
            nodePath.posix.basename("")
        );
        assert.deepEqual(
            path.basename("/foo/bar/"),
            nodePath.posix.basename("/foo/bar/")
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
        if (process.platform === "win32") {
            assert.deepEqual(
                path.relative(
                    "C:\\Users\\lepag\\fullstackedorg\\fullstacked",
                    "/C:/Users/lepag/fullstackedorg/fullstacked/node_modules/@fullstacked/tailwindcss/index.js.js"
                ),
                nodePath.relative(
                    "C:\\Users\\lepag\\fullstackedorg\\fullstacked",
                    "C:/Users/lepag/fullstackedorg/fullstacked/node_modules/@fullstacked/tailwindcss/index.js.js"
                )
            );
        }
    });
});
