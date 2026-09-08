import { suite, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "../../core/internal/bundle/lib/fs/index.ts";
import {
    getConfig,
    setConfig,
    deleteConfig,
    loadConfig
} from "../../core/internal/bundle/lib/config/index.ts";
import parentWindow from "../../core/internal/bundle/lib/parentWindow/index.ts";
import {
    core,
    staticFileResolve
} from "../../platform/node/src/index.ts";
import {
    serialize,
    deserialize
} from "../../core/internal/bundle/lib/bridge/serialization.ts";
import os from "node:os";
import path from "node:path";
import nodeFs from "node:fs";

function getNativeConfig(ctx: number, key: string): string | null {
    const payload = new Uint8Array([
        ctx,
        0, // id
        16, // Config
        0, // Get
        1, // Sync
        ...serialize(key)
    ]);
    const res = core.call(payload.buffer as ArrayBuffer);
    if (res.byteLength > 1 && new Uint8Array(res)[0] === 1) {
        const { data } = deserialize(res, 1);
        if (typeof data === "string") {
            const str = data.trim();
            if (str) return str;
        }
    }
    return null;
}

function startMain(
    root: string,
    build: string,
    skipInitialDir = false
): number {
    const mainCtx = core.start(root, build);
    if (skipInitialDir) return mainCtx;

    const initialDir = getNativeConfig(mainCtx, "initialDirectory");
    if (initialDir) {
        core.stop(mainCtx);

        const subPath = initialDir.startsWith("/") ? initialDir.slice(1) : initialDir;
        const targetDir = path.resolve(root, subPath);
        return core.start(targetDir, targetDir);
    }

    return mainCtx;
}

function getLaunchDirectory(baseDir: string, skipInitialDir = false): string {
    if (skipInitialDir) return baseDir;
    const ctx = core.start(baseDir, baseDir);
    try {
        const initialDir = getNativeConfig(ctx, "initialDirectory");
        if (initialDir) {
            const subPath = initialDir.startsWith("/") ? initialDir.slice(1) : initialDir;
            return path.resolve(baseDir, subPath);
        }
    } finally {
        core.stop(ctx);
    }
    return baseDir;
}

suite("config - e2e", () => {
    let tmpDir: string;
    let testCtx: number;
    let originalCtx: number;

    before(() => {
        tmpDir = path.join(os.tmpdir(), `fs-config-test-${Date.now()}`);
        nodeFs.mkdirSync(tmpDir, { recursive: true });
        testCtx = core.start(tmpDir, tmpDir);
        originalCtx = (globalThis as any).bridge.ctx;
        (globalThis as any).bridge.ctx = testCtx;
        (globalThis as any).bridge.ctxId = testCtx;
    });

    after(() => {
        (globalThis as any).bridge.ctx = originalCtx;
        (globalThis as any).bridge.ctxId = originalCtx;
        try {
            core.stop(testCtx);
        } catch { }
        try {
            nodeFs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { }
    });

    beforeEach(async () => {
        try {
            await fs.promises.unlink("/.git/config.json");
        } catch { }
    });

    afterEach(async () => {
        try {
            await fs.promises.unlink("/.git/config.json");
        } catch { }
    });

    test("setConfig, getConfig, deleteConfig, loadConfig", async () => {
        assert.deepEqual(await loadConfig(), {});
        assert.strictEqual(await getConfig("initialDirectory"), undefined);

        await setConfig("initialDirectory", "/app/my-project");
        assert.strictEqual(
            await getConfig("initialDirectory"),
            "/app/my-project"
        );

        // Verify /.git/config.json content directly in context filesystem
        const fileContent = await fs.promises.readFile("/.git/config.json", {
            encoding: "utf-8"
        });
        const parsed = JSON.parse(fileContent);
        assert.strictEqual(parsed.initialDirectory, "/app/my-project");

        // Verify no lock file is created
        assert.strictEqual(fs.existsSync("/.config.lock"), false);
        assert.strictEqual(fs.existsSync("/.git/.config.lock"), false);

        // Add additional configuration values
        await setConfig("windowSize", "1024:768:100:100");
        assert.strictEqual(
            await getConfig("windowSize"),
            "1024:768:100:100"
        );
        await setConfig("theme", "dark");

        const all = await loadConfig();
        assert.strictEqual(all.initialDirectory, "/app/my-project");
        assert.strictEqual(all.windowSize, "1024:768:100:100");
        assert.strictEqual(all.theme, "dark");

        // Delete one key
        await deleteConfig("initialDirectory");
        assert.strictEqual(await getConfig("initialDirectory"), undefined);
        assert.strictEqual(
            await getConfig("windowSize"),
            "1024:768:100:100"
        );
        assert.strictEqual(await getConfig("theme"), "dark");

        // Clean up remaining keys
        await deleteConfig("windowSize");
        await deleteConfig("theme");
        assert.deepEqual(await loadConfig(), {});
    });

    test("parentWindow windowSize integration with config", async () => {
        let resizedTo: string | null = null;
        const originalWindow = (globalThis as any).fullstacked?.window;
        (globalThis as any).fullstacked.window = {
            resize: (size: string) => {
                resizedTo = size;
            }
        };

        try {
            // Set windowSize in config
            await setConfig("windowSize", "1280:800:50:50");
            assert.strictEqual(await getConfig("windowSize"), "1280:800:50:50");

            // Setup parentWindow should read from config and resize window
            await parentWindow.setup();
            assert.strictEqual(resizedTo, "1280:800:50:50");

            // Clean up
            await deleteConfig("windowSize");
        } finally {
            if (originalWindow) {
                (globalThis as any).fullstacked.window = originalWindow;
            } else {
                delete (globalThis as any).fullstacked.window;
            }
        }
    });

    test("native initialDirectory override and panic recovery reversion", async () => {
        // Create custom sub-directory inside tmpDir
        const customSubDir = path.join(tmpDir, "my-custom-project");
        nodeFs.mkdirSync(customSubDir, { recursive: true });

        await setConfig("initialDirectory", "/my-custom-project");

        // Normal startup: overrides main app directory with initialDirectory
        const normalLaunchDir = getLaunchDirectory(tmpDir, false);
        assert.strictEqual(normalLaunchDir, customSubDir);

        // Panic recovery: skipInitialDir reverts to default root directory
        const panicLaunchDir = getLaunchDirectory(tmpDir, true);
        assert.strictEqual(panicLaunchDir, tmpDir);

        // Clean up
        await deleteConfig("initialDirectory");
        assert.strictEqual(getLaunchDirectory(tmpDir, false), tmpDir);
    });

    test("overwrite existing key and delete non-existent key", async () => {
        await setConfig("initialDirectory", "/app/v1");
        assert.strictEqual(await getConfig("initialDirectory"), "/app/v1");

        // Overwrite
        await setConfig("initialDirectory", "/app/v2");
        assert.strictEqual(await getConfig("initialDirectory"), "/app/v2");

        // Delete non-existent key should not throw
        await deleteConfig("nonExistentKey");
        assert.strictEqual(await getConfig("initialDirectory"), "/app/v2");

        await deleteConfig("initialDirectory");
        assert.deepEqual(await loadConfig(), {});
    });

    test("context isolation for centralized config", async () => {
        const dirA = path.join(os.tmpdir(), `fs-config-iso-a-${Date.now()}`);
        const dirB = path.join(os.tmpdir(), `fs-config-iso-b-${Date.now()}`);
        nodeFs.mkdirSync(dirA, { recursive: true });
        nodeFs.mkdirSync(dirB, { recursive: true });

        const ctxA = core.start(dirA, dirA);
        const ctxB = core.start(dirB, dirB);

        try {
            // Set config in Context A
            (globalThis as any).bridge.ctx = ctxA;
            (globalThis as any).bridge.ctxId = ctxA;
            await setConfig("initialDirectory", "/app/project-a");

            // Set config in Context B
            (globalThis as any).bridge.ctx = ctxB;
            (globalThis as any).bridge.ctxId = ctxB;
            await setConfig("initialDirectory", "/app/project-b");

            // Check Context A
            (globalThis as any).bridge.ctx = ctxA;
            (globalThis as any).bridge.ctxId = ctxA;
            assert.strictEqual(
                await getConfig("initialDirectory"),
                "/app/project-a"
            );

            // Check Context B
            (globalThis as any).bridge.ctx = ctxB;
            (globalThis as any).bridge.ctxId = ctxB;
            assert.strictEqual(
                await getConfig("initialDirectory"),
                "/app/project-b"
            );
        } finally {
            (globalThis as any).bridge.ctx = testCtx;
            (globalThis as any).bridge.ctxId = testCtx;
            try {
                core.stop(ctxA);
            } catch { }
            try {
                core.stop(ctxB);
            } catch { }
            try {
                nodeFs.rmSync(dirA, { recursive: true, force: true });
            } catch { }
            try {
                nodeFs.rmSync(dirB, { recursive: true, force: true });
            } catch { }
        }
    });

    test("native panic exit binary payload [ctx, 0, 0, 5, 0]", async () => {
        const panicTmpDir = path.join(
            os.tmpdir(),
            `fs-test-panic-${Date.now()}`
        );
        nodeFs.mkdirSync(panicTmpDir, { recursive: true });

        try {
            // Start a new isolated context
            const panicCtx = core.start(panicTmpDir, panicTmpDir);
            assert.strictEqual(typeof panicCtx, "number");
            assert.strictEqual(core.check(panicCtx), true);

            // Execute exit binary payload: [ctx, reqId=0, coreModule=0, exitFn=5 (router.Exit), isSync=0]
            const exitPayload = new Uint8Array([panicCtx, 0, 0, 5, 0]);
            core.call(exitPayload.buffer as ArrayBuffer);

            // Context should now be marked for exit (core.check returns false)
            assert.strictEqual(core.check(panicCtx), false);
        } finally {
            try {
                nodeFs.rmSync(panicTmpDir, { recursive: true, force: true });
            } catch { }
        }
    });

    test("Config module (mod 16) binary calls: Get, Set, Delete, Load", async () => {
        const testDir = path.join(
            os.tmpdir(),
            `fs-test-cfgmod-${Date.now()}`
        );
        nodeFs.mkdirSync(testDir, { recursive: true });

        try {
            const ctx = core.start(testDir, testDir);
            try {
                // 1. Get non-existent key: mod=16, fn=0, sync=1, key="initialDirectory"
                const keyBytes = Buffer.from("initialDirectory", "utf-8");
                const lenBuf = Buffer.alloc(4);
                lenBuf.writeUInt32BE(keyBytes.length);
                const getPayload = new Uint8Array([
                    ctx, 0, 16, 0, 1, 2, ...lenBuf, ...keyBytes
                ]);
                let res = Buffer.from(core.call(getPayload.buffer as ArrayBuffer));
                assert.strictEqual(res[0], 1); // CoreResponseData
                assert.strictEqual(res[1], undefined); // UNDEFINED

                // 2. Set key: mod=16, fn=1, sync=1, key="initialDirectory", val="/my-app"
                const valBytes = Buffer.from("/my-app", "utf-8");
                const valLenBuf = Buffer.alloc(4);
                valLenBuf.writeUInt32BE(valBytes.length);
                const setPayload = new Uint8Array([
                    ctx, 0, 16, 1, 1,
                    2, ...lenBuf, ...keyBytes,
                    2, ...valLenBuf, ...valBytes
                ]);
                res = Buffer.from(core.call(setPayload.buffer as ArrayBuffer));
                assert.strictEqual(res[0], 1); // CoreResponseData

                // Verify file written to disk
                const fileContent = nodeFs.readFileSync(
                    path.join(testDir, ".git", "config.json"),
                    "utf-8"
                );
                assert.strictEqual(JSON.parse(fileContent).initialDirectory, "/my-app");

                // 3. Get key using getNativeConfig
                const nativeVal = getNativeConfig(ctx, "initialDirectory");
                assert.strictEqual(nativeVal, "/my-app");

                // 4. Load all: mod=16, fn=3, sync=1
                const loadPayload = new Uint8Array([ctx, 0, 16, 3, 1]);
                res = Buffer.from(core.call(loadPayload.buffer as ArrayBuffer));
                assert.strictEqual(res[0], 1);
                assert.strictEqual(res[1], 5); // OBJECT
                const objLen = res.readUInt32BE(2);
                const loaded = JSON.parse(res.subarray(6, 6 + objLen).toString("utf-8"));
                assert.strictEqual(loaded.initialDirectory, "/my-app");

                // 5. Delete key: mod=16, fn=2, sync=1, key="initialDirectory"
                const delPayload = new Uint8Array([
                    ctx, 0, 16, 2, 1, 2, ...lenBuf, ...keyBytes
                ]);
                res = Buffer.from(core.call(delPayload.buffer as ArrayBuffer));
                assert.strictEqual(res[0], 1);

                // 6. Get deleted key
                const deletedVal = getNativeConfig(ctx, "initialDirectory");
                assert.strictEqual(deletedVal, null);
            } finally {
                core.stop(ctx);
            }
        } finally {
            try {
                nodeFs.rmSync(testDir, { recursive: true, force: true });
            } catch { }
        }
    });

    test("startMain with Config module overrides context root and supports panic recovery", async () => {
        const baseDir = path.join(
            os.tmpdir(),
            `fs-test-startmain-${Date.now()}`
        );
        const subProjectDir = path.join(baseDir, "workspace-app");
        nodeFs.mkdirSync(subProjectDir, { recursive: true });

        // Write config with initialDirectory
        nodeFs.mkdirSync(path.join(baseDir, ".git"), { recursive: true });
        nodeFs.writeFileSync(
            path.join(baseDir, ".git", "config.json"),
            JSON.stringify({ initialDirectory: "/workspace-app" })
        );

        // Normal start: starts default context, queries Config module, closes default and spawns at initialDirectory
        const dummyOriginalBuild = path.join(baseDir, "original-build");
        nodeFs.mkdirSync(dummyOriginalBuild, { recursive: true });
        nodeFs.writeFileSync(path.join(dummyOriginalBuild, "dummy.txt"), "from-dummy");

        nodeFs.mkdirSync(path.join(subProjectDir, "out"), { recursive: true });
        nodeFs.writeFileSync(path.join(subProjectDir, "root.txt"), "from-root");
        nodeFs.writeFileSync(path.join(subProjectDir, "out", "build.txt"), "from-build");

        const normalCtx = startMain(baseDir, dummyOriginalBuild, false);
        assert.strictEqual(typeof normalCtx, "number");
        assert.strictEqual(core.check(normalCtx), true);

        // Verify root and build directory override:
        // root.txt is in subProjectDir (root)
        const rootContent = staticFileResolve(normalCtx, "root.txt");
        assert.strictEqual(rootContent?.found, true);
        assert.strictEqual(new TextDecoder().decode(rootContent.data), "from-root");

        // build.txt is in subProjectDir/out (build)
        const buildContent = staticFileResolve(normalCtx, "build.txt");
        assert.strictEqual(buildContent?.found, true);
        assert.strictEqual(new TextDecoder().decode(buildContent.data), "from-build");

        // dummy.txt was in dummyOriginalBuild which was overridden, so it should not be resolved
        const dummyContent = staticFileResolve(normalCtx, "dummy.txt");
        assert.strictEqual(dummyContent?.found, false);

        core.stop(normalCtx);

        // Panic recovery: starts at baseDir ignoring initialDirectory
        const panicCtx = startMain(baseDir, baseDir, true);
        assert.strictEqual(typeof panicCtx, "number");
        assert.strictEqual(core.check(panicCtx), true);
        core.stop(panicCtx);

        try {
            nodeFs.rmSync(baseDir, { recursive: true, force: true });
        } catch { }
    });
});
