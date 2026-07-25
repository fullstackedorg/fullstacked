import { execute } from "../../core/internal/bundle/lib/fullstacked/index.ts";

async function runTests() {
    console.log("Running FullStacked execute tests...");

    // Test 1: Invalid command (no 'fullstacked' token)
    let stderrOutput = "";
    const dummyStderr = {
        write: (msg: string) => {
            stderrOutput += msg;
        }
    };
    const codeInvalid = await execute("invalid_command", {
        stdio: [null, null, dummyStderr]
    });
    if (codeInvalid !== 1) {
        throw new Error(
            `Expected exit code 1 for invalid command, got ${codeInvalid}`
        );
    }
    if (!stderrOutput.includes("Error")) {
        throw new Error(
            `Expected error output in stderr, got '${stderrOutput}'`
        );
    }
    console.log(
        "Test 1 Passed: Invalid command returns exit code 1 with error message."
    );

    // Test 2: Sanitization test - leading tokens stripped prior to 'fullstacked'
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
    if (codeVersion !== 0) {
        throw new Error(
            `Expected exit code 0 for --version, got ${codeVersion}`
        );
    }
    if (!stdoutVersion.includes("FullStacked v")) {
        throw new Error(`Expected version output, got '${stdoutVersion}'`);
    }
    console.log(
        "Test 2 Passed: Command sanitization stripped leading tokens ('node /usr/bin/npx')."
    );

    // Test 3: --help flag
    let stdoutHelp = "";
    const dummyStdoutHelp = {
        write: (msg: string) => {
            stdoutHelp += msg;
        }
    };
    const codeHelp = await execute(["node", "fullstacked", "--help"], {
        stdio: [null, dummyStdoutHelp, null]
    });
    if (codeHelp !== 0) {
        throw new Error(`Expected exit code 0 for --help, got ${codeHelp}`);
    }
    if (!stdoutHelp.includes("Usage:")) {
        throw new Error(`Expected help output, got '${stdoutHelp}'`);
    }
    console.log(
        "Test 3 Passed: --help flag returned exit code 0 with help text."
    );

    console.log("All execute unit tests passed successfully!");
}

runTests().catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
});
