import test, { suite } from "node:test";
import assert from "node:assert";
import * as fs from "../../core/internal/bundle/lib/fs/index.ts";
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
            fs.readFileSync("package.json", { encoding: "base64" }),
            nodeFs.readFileSync("package.json", { encoding: "base64" })
        );
        assert.deepEqual(
            fs.readFileSync("package.json", { encoding: "ascii" }),
            nodeFs.readFileSync("package.json", { encoding: "ascii" })
        );
    });

    test("readFile", (_, done) => {
        fs.readFile("package.json", (_, data) => {
            nodeFs.readFile("package.json", (_, nodeData) => {
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

    test("readdirSync", () => {
        assert.deepEqual(fs.readdirSync("."), nodeFs.readdirSync("."));

        const withFileTypes = fs.readdirSync(".", { withFileTypes: true });
        const withFileTypesNode = nodeFs.readdirSync(".", {
            withFileTypes: true
        });
        withFileTypes.forEach((item, index) => {
            assert.deepEqual(item.name, withFileTypesNode.at(index).name);
            assert.deepEqual(
                item.parentPath,
                withFileTypesNode.at(index).parentPath
            );
            assert.deepStrictEqual(
                item.isDirectory(),
                withFileTypesNode.at(index).isDirectory()
            );
            assert.deepStrictEqual(
                item.isFile(),
                withFileTypesNode.at(index).isFile()
            );
        });

        assert.deepEqual(
            fs.readdirSync("test", { recursive: true }).sort(),
            nodeFs.readdirSync("test", { recursive: true }).sort()
        );

        const sortDirent = (a: fs.Dirent, b: fs.Dirent) => {
            if (a.name < b.name) {
                return -1;
            } else if (a.name > b.name) {
                return 1;
            } else if (a.parentPath < b.parentPath) {
                return -1;
            } else {
                return 1;
            }
        };

        const withFileTypesRecursive = fs
            .readdirSync("test", { withFileTypes: true, recursive: true })
            .sort(sortDirent);
        const withFileTypesNodeRecursive = nodeFs
            .readdirSync("test", { withFileTypes: true, recursive: true })
            .sort(sortDirent);

        withFileTypesRecursive.forEach((item, index) => {
            assert.deepEqual(
                item.name,
                withFileTypesNodeRecursive.at(index).name
            );
            assert.deepEqual(
                item.parentPath,
                withFileTypesNodeRecursive.at(index).parentPath
            );
            assert.deepStrictEqual(
                item.isDirectory(),
                withFileTypesNodeRecursive.at(index).isDirectory()
            );
            assert.deepStrictEqual(
                item.isFile(),
                withFileTypesNodeRecursive.at(index).isFile()
            );
        });
    });

    test("readdir", (_, done) => {
        fs.readdir("test", { withFileTypes: true }, (_, items) => {
            nodeFs.readdir("test", { withFileTypes: true }, (_, nodeItems) => {
                try {
                    items.forEach((item, index) => {
                        assert.deepEqual(item.name, nodeItems.at(index).name);
                        assert.deepEqual(
                            item.parentPath,
                            nodeItems.at(index).parentPath
                        );
                        assert.deepStrictEqual(
                            item.isDirectory(),
                            nodeItems.at(index).isDirectory()
                        );
                        assert.deepStrictEqual(
                            item.isFile(),
                            nodeItems.at(index).isFile()
                        );
                    });
                    done();
                } catch (e) {
                    return done(e);
                }
            });
        });
    });

    test("promises.readdir", async () => {
        const itemsRecursive = await fs.promises.readdir("test", {
            recursive: true
        });
        const nodeItemsRecursive = await nodeFs.promises.readdir("test", {
            recursive: true
        });
        itemsRecursive.sort();
        nodeItemsRecursive.sort();

        assert.deepEqual(itemsRecursive, nodeItemsRecursive);

        const items = await fs.promises.readdir("test", {
            withFileTypes: true
        });
        const nodeItems = await nodeFs.promises.readdir("test", {
            withFileTypes: true
        });

        items.forEach((item, index) => {
            assert.deepEqual(item.name, nodeItems.at(index).name);
            assert.deepEqual(item.parentPath, nodeItems.at(index).parentPath);
            assert.deepStrictEqual(
                item.isDirectory(),
                nodeItems.at(index).isDirectory()
            );
            assert.deepStrictEqual(item.isFile(), nodeItems.at(index).isFile());
        });
    });

    test("mkdirSync", () => {
        const path = "test-mkdir-sync";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmdirSync(path);
        }

        fs.mkdirSync(path);
        assert.ok(nodeFs.existsSync(path));

        const stats = fs.statSync(path);
        const nodeStats = nodeFs.statSync(path);
        assert.deepEqual(stats.mode, nodeStats.mode);

        nodeFs.rmdirSync(path);
    });

    test("mkdir", (_, done) => {
        const path = "test-mkdir-callback";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmdirSync(path);
        }

        fs.mkdir(path, (err) => {
            if (err) return done(err);

            try {
                assert.ok(nodeFs.existsSync(path));
                const stats = fs.statSync(path);
                const nodeStats = nodeFs.statSync(path);
                assert.deepEqual(stats.mode, nodeStats.mode);
                nodeFs.rmdirSync(path);
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    test("promises.mkdir", async () => {
        const path = "test-mkdir-promise";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmdirSync(path);
        }

        await fs.promises.mkdir(path);
        assert.ok(nodeFs.existsSync(path));

        const stats = await fs.promises.stat(path);
        const nodeStats = await nodeFs.promises.stat(path);
        assert.deepEqual(stats.mode, nodeStats.mode);

        nodeFs.rmdirSync(path);
    });

    test("rmSync", () => {
        const path = "test-rm-sync";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path, { recursive: true, force: true });
        }
        nodeFs.mkdirSync(path);
        fs.rmSync(path);
        assert.equal(nodeFs.existsSync(path), false);

        nodeFs.writeFileSync(path, "test");
        fs.rmSync(path);
        assert.equal(nodeFs.existsSync(path), false);
    });

    test("rm", (_, done) => {
        const path = "test-rm-callback";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path, { recursive: true, force: true });
        }
        nodeFs.mkdirSync(path);

        fs.rm(path, (err) => {
            if (err) return done(err);
            try {
                assert.equal(nodeFs.existsSync(path), false);

                nodeFs.writeFileSync(path, "test");
                fs.rm(path, (err) => {
                    if (err) return done(err);
                    try {
                        assert.equal(nodeFs.existsSync(path), false);
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
            } catch (e) {
                done(e);
            }
        });
    });

    test("promises.rm", async () => {
        const path = "test-rm-promise";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path, { recursive: true, force: true });
        }
        nodeFs.mkdirSync(path);

        await fs.promises.rm(path);
        assert.equal(nodeFs.existsSync(path), false);

        nodeFs.writeFileSync(path, "test");
        await fs.promises.rm(path);
        assert.equal(nodeFs.existsSync(path), false);
    });
    test("renameSync", () => {
        const path = "test-rename-sync";
        const newPath = "test-rename-sync-new";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }
        if (nodeFs.existsSync(newPath)) {
            nodeFs.rmSync(newPath);
        }

        nodeFs.writeFileSync(path, "test");
        fs.renameSync(path, newPath);

        assert.equal(nodeFs.existsSync(path), false);
        assert.equal(nodeFs.existsSync(newPath), true);
        assert.equal(nodeFs.readFileSync(newPath, "utf-8"), "test");

        nodeFs.rmSync(newPath);
    });

    test("rename", (_, done) => {
        const path = "test-rename-callback";
        const newPath = "test-rename-callback-new";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }
        if (nodeFs.existsSync(newPath)) {
            nodeFs.rmSync(newPath);
        }

        nodeFs.writeFileSync(path, "test");
        fs.rename(path, newPath, (err) => {
            if (err) return done(err);
            try {
                assert.equal(nodeFs.existsSync(path), false);
                assert.equal(nodeFs.existsSync(newPath), true);
                assert.equal(nodeFs.readFileSync(newPath, "utf-8"), "test");
                nodeFs.rmSync(newPath);
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    test("promises.rename", async () => {
        const path = "test-rename-promise";
        const newPath = "test-rename-promise-new";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }
        if (nodeFs.existsSync(newPath)) {
            nodeFs.rmSync(newPath);
        }

        nodeFs.writeFileSync(path, "test");
        await fs.promises.rename(path, newPath);

        assert.equal(nodeFs.existsSync(path), false);
        assert.equal(nodeFs.existsSync(newPath), true);
        assert.equal(nodeFs.readFileSync(newPath, "utf-8"), "test");

        nodeFs.rmSync(newPath);
    });
});
