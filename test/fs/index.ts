import test, { suite } from "node:test";
import assert from "node:assert";
import * as fs from "../../lib/fs/index.ts";
import * as nodeFs from "node:fs";

suite("fs - e2e", () => {
    test("existsSync", () => {
        assert.deepEqual(
            fs.existsSync("package.json"),
            nodeFs.existsSync("package.json")
        );
        assert.deepEqual(
            fs.existsSync("not-exists"),
            nodeFs.existsSync("not-exists")
        );
    });

    test("statSync", () => {
        const stats = fs.statSync("package.json");
        const nodeStats = nodeFs.statSync("package.json");

        assert.deepEqual(stats.mode, nodeStats.mode);
        assert.deepEqual(stats.size, nodeStats.size);
        assert.deepEqual(
            Math.floor(stats.atimeMs),
            Math.floor(nodeStats.atimeMs)
        );
        assert.deepEqual(
            Math.floor(stats.mtimeMs),
            Math.floor(nodeStats.mtimeMs)
        );
        assert.deepEqual(
            Math.floor(stats.ctimeMs),
            Math.floor(nodeStats.ctimeMs)
        );
        assert.deepEqual(
            Math.floor(stats.birthtimeMs),
            Math.floor(nodeStats.birthtimeMs)
        );
        assert.deepEqual(stats.atime.toString(), nodeStats.atime.toString());
        assert.deepEqual(stats.mtime.toString(), nodeStats.mtime.toString());
        assert.deepEqual(stats.ctime.toString(), nodeStats.ctime.toString());
        assert.deepEqual(
            stats.birthtime.toString(),
            nodeStats.birthtime.toString()
        );
        assert.deepEqual(stats.isDirectory(), nodeStats.isDirectory());
        assert.deepEqual(stats.isFile(), nodeStats.isFile());
    });

    test("stat", (_, done) => {
        fs.stat("package.json", (_, stats) => {
            nodeFs.stat("package.json", (_, nodeStats) => {
                try {
                    assert.deepEqual(stats.mode, nodeStats.mode);
                    assert.deepEqual(stats.size, nodeStats.size);
                    assert.deepEqual(
                        Math.floor(stats.atimeMs),
                        Math.floor(nodeStats.atimeMs)
                    );
                    assert.deepEqual(
                        Math.floor(stats.mtimeMs),
                        Math.floor(nodeStats.mtimeMs)
                    );
                    assert.deepEqual(
                        Math.floor(stats.ctimeMs),
                        Math.floor(nodeStats.ctimeMs)
                    );
                    assert.deepEqual(
                        Math.floor(stats.birthtimeMs),
                        Math.floor(nodeStats.birthtimeMs)
                    );
                    assert.deepEqual(
                        stats.atime.toString(),
                        nodeStats.atime.toString()
                    );
                    assert.deepEqual(
                        stats.mtime.toString(),
                        nodeStats.mtime.toString()
                    );
                    assert.deepEqual(
                        stats.ctime.toString(),
                        nodeStats.ctime.toString()
                    );
                    assert.deepEqual(
                        stats.birthtime.toString(),
                        nodeStats.birthtime.toString()
                    );
                    assert.deepEqual(
                        stats.isDirectory(),
                        nodeStats.isDirectory()
                    );
                    assert.deepEqual(stats.isFile(), nodeStats.isFile());
                    done();
                } catch (e) {
                    done(e);
                }
            });
        });
    });

    test("promises.stat", async () => {
        const stats = await fs.promises.stat("package.json");
        const nodeStats = await nodeFs.promises.stat("package.json");

        assert.deepEqual(stats.mode, nodeStats.mode);
        assert.deepEqual(stats.size, nodeStats.size);
        assert.deepEqual(
            Math.floor(stats.atimeMs),
            Math.floor(nodeStats.atimeMs)
        );
        assert.deepEqual(
            Math.floor(stats.mtimeMs),
            Math.floor(nodeStats.mtimeMs)
        );
        assert.deepEqual(
            Math.floor(stats.ctimeMs),
            Math.floor(nodeStats.ctimeMs)
        );
        assert.deepEqual(
            Math.floor(stats.birthtimeMs),
            Math.floor(nodeStats.birthtimeMs)
        );
        assert.deepEqual(stats.atime.toString(), nodeStats.atime.toString());
        assert.deepEqual(stats.mtime.toString(), nodeStats.mtime.toString());
        assert.deepEqual(stats.ctime.toString(), nodeStats.ctime.toString());
        assert.deepEqual(
            stats.birthtime.toString(),
            nodeStats.birthtime.toString()
        );
        assert.deepEqual(stats.isDirectory(), nodeStats.isDirectory());
        assert.deepEqual(stats.isFile(), nodeStats.isFile());
    });

    test("readFileSync", () => {
        assert.deepEqual(
            fs.readFileSync("package.json"),
            nodeFs.readFileSync("package.json")
        );
        assert.deepEqual(
            fs.readFileSync("package.json", { encoding: "utf-8" }),
            nodeFs.readFileSync("package.json", { encoding: "utf-8" })
        );
        assert.deepEqual(
            fs.readFileSync("package.json", { encoding: "utf-16le" }),
            nodeFs.readFileSync("package.json", { encoding: "utf-16le" })
        );
        // assert.deepEqual(
        //     fs.readFileSync("package.json", { encoding: "ascii" }),
        //     nodeFs.readFileSync("package.json", { encoding: "ascii" })
        // );
    });

    test("readFile", (_, done) => {
        fs.readFile("package.json", (_, data) => {
            nodeFs.readFile("package.json", (err, nodeData) => {
                try {
                    assert.deepEqual(data, nodeData);
                    done();
                } catch (e) {
                    return done(e);
                }
            });
        });
    });

    test("promises.readFile", async () => {
        assert.deepEqual(
            await fs.promises.readFile("package.json"),
            await nodeFs.promises.readFile("package.json")
        );
        assert.deepEqual(
            await fs.promises.readFile("package.json", { encoding: "utf-8" }),
            await nodeFs.promises.readFile("package.json", {
                encoding: "utf-8"
            })
        );
    });
});
