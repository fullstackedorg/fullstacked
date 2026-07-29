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
            const codeArgs1 = await execute(["fullstacked", "-f", testFile1, "--debug"]);
            assert.strictEqual(codeArgs1, 0);
        } finally {
            if (nodeFs.existsSync(testFile1)) nodeFs.unlinkSync(testFile1);
            if (nodeFs.existsSync(testFile1 + ".js")) nodeFs.unlinkSync(testFile1 + ".js");
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
            const codeArgs2 = await execute(["fullstacked", "-f", testFile2, "--debug", "foo", "--bar=123"]);
            assert.strictEqual(codeArgs2, 0);
        } finally {
            if (nodeFs.existsSync(testFile2)) nodeFs.unlinkSync(testFile2);
            if (nodeFs.existsSync(testFile2 + ".js")) nodeFs.unlinkSync(testFile2 + ".js");
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
            if (nodeFs.existsSync(testFile3 + ".js")) nodeFs.unlinkSync(testFile3 + ".js");
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
            if (nodeFs.existsSync(testFile4 + ".js")) nodeFs.unlinkSync(testFile4 + ".js");
        }
    });
});




