import assert from "node:assert";
import test, { suite } from "node:test";
import { execute } from "../../core/internal/bundle/lib/fullstacked/index.ts";
import nodeFs from "node:fs";
import path from "node:path";

const outDir = path.join("test", "fullstacked", "out");

suite("fullstacked - e2e", () => {
    nodeFs.mkdirSync(outDir, { recursive: true });

    test("invalid command", async () => {
        let stderrOutput = "";
        const dummyStderr = {
            write: (msg: string) => {
                stderrOutput += msg;
            }
        };
        const codeInvalid = await execute("invalid_command", {
            stdio: [null, null, dummyStderr]
        });
        assert.strictEqual(codeInvalid, 1);
        assert.ok(stderrOutput.includes("Error"));
    });

    test("command sanitization with --version", async () => {
        let stdoutVersion = "";
        const dummyStdoutVersion = {
            write: (msg: string) => {
                stdoutVersion += msg;
            }
        };
        const codeVersion = await execute(
            "node /usr/bin/npx fullstacked --version",
            {
                stdio: [null, dummyStdoutVersion, null]
            }
        );
        assert.strictEqual(codeVersion, 0);
        assert.ok(stdoutVersion.includes("FullStacked v"));
    });

    test("--help flag", async () => {
        let stdoutHelp = "";
        const dummyStdoutHelp = {
            write: (msg: string) => {
                stdoutHelp += msg;
            }
        };
        const codeHelp = await execute(["node", "fullstacked", "--help"], {
            stdio: [null, dummyStdoutHelp, null]
        });
        assert.strictEqual(codeHelp, 0);
        assert.ok(stdoutHelp.includes("Usage:"));
    });

    test("extra flag passing (-f with --debug)", async () => {
        const testFile1 = path.join(outDir, "test-args-1.ts");
        nodeFs.writeFileSync(
            testFile1,
            `import process from "process";
if (!process.argv.includes("--debug")) {
    throw new Error("Expected --debug in process.argv");
}`
        );
        try {
            const codeArgs1 = await execute([
                "fullstacked",
                "-f",
                testFile1,
                "--debug"
            ]);
            assert.strictEqual(codeArgs1, 0);
        } finally {
            if (nodeFs.existsSync(testFile1)) nodeFs.unlinkSync(testFile1);
            if (nodeFs.existsSync(testFile1 + ".js"))
                nodeFs.unlinkSync(testFile1 + ".js");
        }
    });

    test("multiple flags & positional args", async () => {
        const testFile2 = path.join(outDir, "test-args-2.ts");
        nodeFs.writeFileSync(
            testFile2,
            `import process from "process";
if (!process.argv.includes("--debug") || !process.argv.includes("foo") || !process.argv.includes("--bar=123")) {
    throw new Error("Expected --debug, foo, and --bar=123 in process.argv, got: " + JSON.stringify(process.argv));
}`
        );
        try {
            const codeArgs2 = await execute([
                "fullstacked",
                "-f",
                testFile2,
                "--debug",
                "foo",
                "--bar=123"
            ]);
            assert.strictEqual(codeArgs2, 0);
        } finally {
            if (nodeFs.existsSync(testFile2)) nodeFs.unlinkSync(testFile2);
            if (nodeFs.existsSync(testFile2 + ".js"))
                nodeFs.unlinkSync(testFile2 + ".js");
        }
    });

    test("standard run without extra flags", async () => {
        const testFile3 = path.join(outDir, "test-args-3.ts");
        nodeFs.writeFileSync(
            testFile3,
            `import process from "process";
if (process.argv.length !== 0) {
    throw new Error("Expected empty process.argv without extra args, got: " + JSON.stringify(process.argv));
}`
        );
        try {
            const codeArgs3 = await execute(["fullstacked", "-f", testFile3]);
            assert.strictEqual(codeArgs3, 0);
        } finally {
            if (nodeFs.existsSync(testFile3)) nodeFs.unlinkSync(testFile3);
            if (nodeFs.existsSync(testFile3 + ".js"))
                nodeFs.unlinkSync(testFile3 + ".js");
        }
    });

    test("re-running same file multiple times", async () => {
        const testFile4 = path.join(outDir, "test-rerun.ts");
        nodeFs.writeFileSync(
            testFile4,
            `globalThis.__runCount = (globalThis.__runCount || 0) + 1;`
        );
        try {
            delete (globalThis as any).__runCount;
            const code1 = await execute(["fullstacked", "-f", testFile4]);
            assert.strictEqual(code1, 0);
            assert.strictEqual((globalThis as any).__runCount, 1);

            const code2 = await execute(["fullstacked", "-f", testFile4]);
            assert.strictEqual(code2, 0);
            assert.strictEqual((globalThis as any).__runCount, 2);
        } finally {
            delete (globalThis as any).__runCount;
            if (nodeFs.existsSync(testFile4)) nodeFs.unlinkSync(testFile4);
            if (nodeFs.existsSync(testFile4 + ".js"))
                nodeFs.unlinkSync(testFile4 + ".js");
        }
    });

    test("running file with .env in process.cwd() and cli overrides", async () => {
        const testFileEnv = path.join(outDir, "test-file-env.ts");
        const cwdEnv = path.resolve(".env");
        const hadOriginalEnv = nodeFs.existsSync(cwdEnv);
        const originalEnvContent = hadOriginalEnv
            ? nodeFs.readFileSync(cwdEnv, "utf-8")
            : "";

        nodeFs.writeFileSync(
            cwdEnv,
            `TEST_CWD_ENV=cwd_val\nTEST_SHARED_ENV=from_env\nTEST_QUOTED="hello world"`
        );
        nodeFs.writeFileSync(
            testFileEnv,
            `import assert from "node:assert";
assert.strictEqual(process.env.TEST_CWD_ENV, "cwd_val");
assert.strictEqual(process.env.TEST_SHARED_ENV, "from_cli");
assert.strictEqual(process.env.TEST_CLI_ONLY, "from_cli_only");
assert.strictEqual(process.env.TEST_QUOTED, "hello world");`
        );

        try {
            const code = await execute([
                "fullstacked",
                "-f",
                testFileEnv,
                "-e",
                "TEST_SHARED_ENV=from_cli",
                "-e",
                "TEST_CLI_ONLY=from_cli_only"
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(process.env.TEST_CWD_ENV, "cwd_val");
            assert.strictEqual(process.env.TEST_SHARED_ENV, "from_cli");
            assert.strictEqual(process.env.TEST_CLI_ONLY, "from_cli_only");
            assert.strictEqual(process.env.TEST_QUOTED, "hello world");
        } finally {
            if (hadOriginalEnv) {
                nodeFs.writeFileSync(cwdEnv, originalEnvContent);
            } else if (nodeFs.existsSync(cwdEnv)) {
                nodeFs.unlinkSync(cwdEnv);
            }
            if (nodeFs.existsSync(testFileEnv)) nodeFs.unlinkSync(testFileEnv);
            if (nodeFs.existsSync(testFileEnv + ".js"))
                nodeFs.unlinkSync(testFileEnv + ".js");
            delete process.env.TEST_CWD_ENV;
            delete process.env.TEST_SHARED_ENV;
            delete process.env.TEST_CLI_ONLY;
            delete process.env.TEST_QUOTED;
        }
    });

    test("running file when .env is absent", async () => {
        const testFileNoEnv = path.join(outDir, "test-file-no-env.ts");
        const cwdEnv = path.resolve(".env");
        assert.strictEqual(nodeFs.existsSync(cwdEnv), false);

        nodeFs.writeFileSync(
            testFileNoEnv,
            `import assert from "node:assert";
assert.strictEqual(process.env.TEST_CLI_ONLY, "from_cli");`
        );

        try {
            const code = await execute([
                "fullstacked",
                "-f",
                testFileNoEnv,
                "-e",
                "TEST_CLI_ONLY=from_cli"
            ]);
            assert.strictEqual(code, 0);
            assert.strictEqual(process.env.TEST_CLI_ONLY, "from_cli");
        } finally {
            if (nodeFs.existsSync(testFileNoEnv))
                nodeFs.unlinkSync(testFileNoEnv);
            if (nodeFs.existsSync(testFileNoEnv + ".js"))
                nodeFs.unlinkSync(testFileNoEnv + ".js");
            delete process.env.TEST_CLI_ONLY;
        }
    });

    test("running directory with .env directly in directory and cli overrides", async () => {
        const testDir = path.join(outDir, "test-dir-env");
        nodeFs.mkdirSync(testDir, { recursive: true });
        nodeFs.writeFileSync(
            path.join(testDir, "index.ts"),
            "export default () => {};"
        );
        nodeFs.writeFileSync(
            path.join(testDir, ".env"),
            "DIR_VAR=dir_val\nOVERRIDE_VAR=from_env"
        );

        let capturedEnv: Record<string, string> | null = null;
        let createdCtx: number | null = null;
        const origBridge = globalThis.fullstacked.bridge;
        globalThis.fullstacked.bridge = function (opts: any, sync?: boolean) {
            if (opts.mod === 0 && opts.fn === 1) {
                capturedEnv = opts.data[1];
            }
            const res = origBridge.apply(this, arguments as any);
            if (opts.mod === 0 && opts.fn === 1) {
                if (res instanceof Promise) {
                    return res.then((id: any) => {
                        createdCtx = id;
                        return id;
                    });
                }
            }
            return res;
        };

        try {
            const code = await execute([
                "fullstacked",
                "-n",
                "-s",
                testDir,
                "-e",
                "OVERRIDE_VAR=from_cli",
                "-e",
                "CLI_ONLY=from_cli_only"
            ]);
            assert.strictEqual(code, 0);
            assert.deepStrictEqual(capturedEnv, {
                DIR_VAR: "dir_val",
                OVERRIDE_VAR: "from_cli",
                CLI_ONLY: "from_cli_only"
            });

            if (createdCtx !== null) {
                const oldCtx = globalThis.fullstacked.platformBridge.bridge.ctx;
                globalThis.fullstacked.platformBridge.bridge.ctx = createdCtx;
                const envInCtx = globalThis.fullstacked.bridge(
                    { mod: 0, fn: 4 },
                    true
                );
                assert.deepStrictEqual(envInCtx, {
                    CLI_ONLY: "from_cli_only",
                    DIR_VAR: "dir_val",
                    OVERRIDE_VAR: "from_cli"
                });
                globalThis.fullstacked.platformBridge.bridge.ctx = oldCtx;
            }
        } finally {
            globalThis.fullstacked.bridge = origBridge;
            nodeFs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test("running directory when .env is absent", async () => {
        const testDirNoEnv = path.join(outDir, "test-dir-no-env");
        nodeFs.mkdirSync(testDirNoEnv, { recursive: true });
        nodeFs.writeFileSync(
            path.join(testDirNoEnv, "index.ts"),
            "export default () => {};"
        );

        let capturedEnv: Record<string, string> | null = null;
        const origBridge = globalThis.fullstacked.bridge;
        globalThis.fullstacked.bridge = function (opts: any, sync?: boolean) {
            if (opts.mod === 0 && opts.fn === 1) {
                capturedEnv = opts.data[1];
            }
            return origBridge.apply(this, arguments as any);
        };

        try {
            const code = await execute([
                "fullstacked",
                "-n",
                "-s",
                testDirNoEnv,
                "-e",
                "CLI_VAR=cli_val"
            ]);
            assert.strictEqual(code, 0);
            assert.deepStrictEqual(capturedEnv, {
                CLI_VAR: "cli_val"
            });
        } finally {
            globalThis.fullstacked.bridge = origBridge;
            nodeFs.rmSync(testDirNoEnv, { recursive: true, force: true });
        }
    });
});
