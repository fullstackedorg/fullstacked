import test, { suite } from "node:test";
import assert from "node:assert";
import * as fs from "../../core/internal/bundle/lib/fs/index.ts";
import * as nodeFs from "node:fs";
import process from "../../core/internal/bundle/lib/process/index.ts";

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
        fs.stat("package-lock.json", (_, stats) => {
            nodeFs.stat("package-lock.json", (_, nodeStats) => {
                try {
                    assert.deepEqual(stats.mode, nodeStats.mode, "mode");
                    assert.deepEqual(stats.size, nodeStats.size, "size");
                    assert.deepEqual(
                        Math.floor(stats.atimeMs),
                        Math.floor(nodeStats.atimeMs),
                        "atimeMs"
                    );
                    assert.deepEqual(
                        Math.floor(stats.mtimeMs),
                        Math.floor(nodeStats.mtimeMs),
                        "mtimeMs"
                    );
                    assert.deepEqual(
                        Math.floor(stats.ctimeMs),
                        Math.floor(nodeStats.ctimeMs),
                        "ctimeMs"
                    );
                    assert.deepEqual(
                        Math.floor(stats.birthtimeMs),
                        Math.floor(nodeStats.birthtimeMs),
                        "birthtimeMs"
                    );
                    assert.deepEqual(
                        stats.atime.toString(),
                        nodeStats.atime.toString(),
                        "atime"
                    );
                    assert.deepEqual(
                        stats.mtime.toString(),
                        nodeStats.mtime.toString(),
                        "mtime"
                    );
                    assert.deepEqual(
                        stats.ctime.toString(),
                        nodeStats.ctime.toString(),
                        "ctime"
                    );
                    assert.deepEqual(
                        stats.birthtime.toString(),
                        nodeStats.birthtime.toString(),
                        "birthtime"
                    );
                    assert.deepEqual(
                        stats.isDirectory(),
                        nodeStats.isDirectory(),
                        "isDirectory"
                    );
                    assert.deepEqual(
                        stats.isFile(),
                        nodeStats.isFile(),
                        "isFile"
                    );
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

        nodeFs.rmSync(path, { recursive: true, force: true });
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
                nodeFs.rmSync(path, { recursive: true, force: true });
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

        nodeFs.rmSync(path, { recursive: true, force: true });
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

    test("createWriteStream", (_, done) => {
        const path = "test-create-write-stream";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }

        const stream = fs.createWriteStream(path);

        stream.on("open", () => {
            stream.write("hello ");
            stream.write("world");
            stream.end();
        });

        stream.once("close", () => {
            try {
                assert.ok(nodeFs.existsSync(path));
                assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello world");
                nodeFs.rmSync(path);
                done();
            } catch (e) {
                done(e);
            }
        });

        stream.once("error", (err) => {
            done(err);
        });
    });

    test("resolve path using changed cwd", () => {
        const originalCwd = process.cwd();
        try {
            if (nodeFs.existsSync("test-dir-cwd")) {
                nodeFs.rmSync("test-dir-cwd", { recursive: true, force: true });
            }
            nodeFs.mkdirSync("test-dir-cwd", { recursive: true });
            nodeFs.writeFileSync("test-dir-cwd/hello.txt", "cwd-work");

            process.chdir("/test-dir-cwd");

            assert.equal(fs.existsSync("hello.txt"), true);
            assert.equal(fs.readFileSync("hello.txt", "utf-8"), "cwd-work");
        } finally {
            process.chdir(originalCwd);
            if (nodeFs.existsSync("test-dir-cwd")) {
                nodeFs.rmSync("test-dir-cwd", { recursive: true, force: true });
            }
        }
    });

    test("prevent sandbox escape traversal", () => {
        // Attempting to escape the root directory using traversal
        // should be restricted to the root directory itself (which is a directory and cannot be read as a file).
        const hostFile = "../test-outside-sandbox.txt";
        nodeFs.writeFileSync(hostFile, "outside");
        try {
            assert.equal(nodeFs.existsSync(hostFile), true);

            // Within sandbox, trying to escape to host file must fail
            assert.throws(() => {
                fs.readFileSync("../test-outside-sandbox.txt");
            });
        } finally {
            if (nodeFs.existsSync(hostFile)) {
                nodeFs.rmSync(hostFile);
            }
        }
    });

    test("chdir resolution, safety and traversal prevention", () => {
        const originalCwd = process.cwd();
        try {
            process.chdir("");
            assert.equal(process.cwd(), "/");

            if (nodeFs.existsSync("test-chdir-safety")) {
                nodeFs.rmSync("test-chdir-safety", {
                    recursive: true,
                    force: true
                });
            }
            nodeFs.mkdirSync("test-chdir-safety/child", { recursive: true });

            process.chdir("/test-chdir-safety");
            assert.equal(process.cwd(), "/test-chdir-safety");

            process.chdir("child");
            assert.equal(process.cwd(), "/test-chdir-safety/child");

            process.chdir("../../../../../");
            assert.equal(process.cwd(), "/");
        } finally {
            process.chdir(originalCwd);
            if (nodeFs.existsSync("test-chdir-safety")) {
                nodeFs.rmSync("test-chdir-safety", {
                    recursive: true,
                    force: true
                });
            }
        }
    });

    test("appendFileSync", () => {
        const path = "test-append-sync";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }

        // 1. Create and write first content
        fs.appendFileSync(path, "hello ");
        assert.ok(nodeFs.existsSync(path));
        assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello ");

        // 2. Append second content
        fs.appendFileSync(path, "world");
        assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello world");

        nodeFs.rmSync(path);
    });

    test("appendFile", (_, done) => {
        const path = "test-append-callback";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }

        fs.appendFile(path, "hello ", (err) => {
            if (err) return done(err);
            try {
                assert.ok(nodeFs.existsSync(path));
                assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello ");

                fs.appendFile(path, "world", (err) => {
                    if (err) return done(err);
                    try {
                        assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello world");
                        nodeFs.rmSync(path);
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

    test("promises.appendFile", async () => {
        const path = "test-append-promise";
        if (nodeFs.existsSync(path)) {
            nodeFs.rmSync(path);
        }

        await fs.promises.appendFile(path, "hello ");
        assert.ok(nodeFs.existsSync(path));
        assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello ");

        await fs.promises.appendFile(path, "world");
        assert.equal(nodeFs.readFileSync(path, "utf-8"), "hello world");

        nodeFs.rmSync(path);
    });
});
