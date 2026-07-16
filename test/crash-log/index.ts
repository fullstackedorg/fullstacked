import test, { before, suite, after } from "node:test";
import assert from "node:assert";
import child_process from "node:child_process";
import fs from "node:fs";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";

suite("crash log - integration", () => {
    const crashLogPath = "test/crash-log/crash.log";

    before(() => {
        // Clean up any existing crash log
        if (fs.existsSync(crashLogPath)) {
            fs.unlinkSync(crashLogPath);
        }
    });

    after(() => {
        // Clean up the generated crash log file
        if (fs.existsSync(crashLogPath)) {
            fs.unlinkSync(crashLogPath);
        }
        // Cleanup sample out dir created during test
        if (fs.existsSync("test/crash-log/sample/out")) {
            fs.rmSync("test/crash-log/sample/out", {
                recursive: true,
                force: true
            });
        }
    });

    test("does not overwrite or truncate crash log on subsequent runs using browser/webview", async () => {
        // 1. Pre-bundle the sample app using the test runner core context
        const result = await bundle.bundle("test/crash-log/sample");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);

        // First run: trigger the first crash
        child_process.spawnSync(
            "node",
            [
                "-r",
                "@nitrogql/esbuild-register",
                "browser-trigger.ts",
                "FIRST_BROWSER_CRASH_PANIC_MESSAGE"
            ],
            {
                cwd: "test/crash-log",
                encoding: "utf8"
            }
        );

        // Verify first run wrote to the crash log
        assert.ok(
            fs.existsSync(crashLogPath),
            "crash.log should exist after first browser crash"
        );
        const logContent1 = fs.readFileSync(crashLogPath, "utf8");
        assert.match(
            logContent1,
            /JS_LOG_PREFIX: FIRST_BROWSER_CRASH_PANIC_MESSAGE/,
            "crash.log should contain the first browser JS append log"
        );
        assert.match(
            logContent1,
            /FIRST_BROWSER_CRASH_PANIC_MESSAGE/,
            "crash.log should contain the first browser crash message"
        );

        // Second run: trigger the second crash
        child_process.spawnSync(
            "node",
            [
                "-r",
                "@nitrogql/esbuild-register",
                "browser-trigger.ts",
                "SECOND_BROWSER_CRASH_PANIC_MESSAGE"
            ],
            {
                cwd: "test/crash-log",
                encoding: "utf8"
            }
        );

        // Verify both crashes are preserved in the log
        assert.ok(fs.existsSync(crashLogPath), "crash.log should still exist");
        const logContent2 = fs.readFileSync(crashLogPath, "utf8");
        assert.match(
            logContent2,
            /JS_LOG_PREFIX: FIRST_BROWSER_CRASH_PANIC_MESSAGE/,
            "crash.log should still contain the first browser JS append log"
        );
        assert.match(
            logContent2,
            /FIRST_BROWSER_CRASH_PANIC_MESSAGE/,
            "crash.log should still contain the first browser crash message"
        );
        assert.match(
            logContent2,
            /JS_LOG_PREFIX: SECOND_BROWSER_CRASH_PANIC_MESSAGE/,
            "crash.log should contain the second browser JS append log"
        );
        assert.match(
            logContent2,
            /SECOND_BROWSER_CRASH_PANIC_MESSAGE/,
            "crash.log should contain the second browser crash message"
        );
    });
});
