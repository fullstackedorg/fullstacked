import test, { suite } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline, {
    createInterface,
    Interface,
    emitKeypressEvents,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    waitForInterfaces,
    getActiveInterfaces
} from "../../core/internal/bundle/lib/readline/index.ts";
import {
    createInterface as createInterfacePromises,
    Interface as InterfacePromises,
    Readline
} from "../../core/internal/bundle/lib/readline/promises.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import fs from "node:fs";
import path from "node:path";

suite("readline - unit & e2e", () => {
    test("exports check", () => {
        assert.ok(typeof createInterface === "function");
        assert.ok(typeof Interface === "function");
        assert.ok(typeof emitKeypressEvents === "function");
        assert.ok(typeof clearLine === "function");
        assert.ok(typeof clearScreenDown === "function");
        assert.ok(typeof cursorTo === "function");
        assert.ok(typeof moveCursor === "function");
        assert.ok(typeof readline.promises === "object");
        assert.ok(typeof createInterfacePromises === "function");
        assert.ok(typeof InterfacePromises === "function");
        assert.ok(typeof Readline === "function");
    });

    test("non-terminal line reading with \\n and \\r\\n", async () => {
        const input = new PassThrough();
        const rl = createInterface({
            input,
            terminal: false
        });

        const lines: string[] = [];
        rl.on("line", (line) => lines.push(line));

        const closed = new Promise<void>((resolve) => rl.on("close", resolve));

        input.write("hello\n");
        input.write("world\r\n");
        input.write("foo\nbar");
        input.end();

        await closed;

        assert.deepStrictEqual(lines, ["hello", "world", "foo", "bar"]);
    });

    test("crlfDelay = Infinity treats split \\r and \\n as single newline", async () => {
        const input = new PassThrough();
        const rl = createInterface({
            input,
            crlfDelay: Infinity,
            terminal: false
        });

        const lines: string[] = [];
        rl.on("line", (line) => lines.push(line));

        const closed = new Promise<void>((resolve) => rl.on("close", resolve));

        input.write("line 1\r");
        await new Promise((r) => setTimeout(r, 50));
        input.write("\nline 2\r\n");
        input.end();

        await closed;

        assert.deepStrictEqual(lines, ["line 1", "line 2"]);
    });

    test("async iterator for await (const line of rl)", async () => {
        const input = new PassThrough();
        const rl = createInterface({
            input,
            terminal: false
        });

        const lines: string[] = [];

        const readPromise = (async () => {
            for await (const line of rl) {
                lines.push(line);
            }
        })();

        input.write("alpha\nbeta\ngamma\n");
        input.end();

        await readPromise;

        assert.deepStrictEqual(lines, ["alpha", "beta", "gamma"]);
    });

    test("question with callback in readline", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let outputData = "";
        output.on("data", (chunk) => {
            outputData += chunk.toString();
        });

        const rl = createInterface({
            input,
            output,
            terminal: false
        });

        const answerPromise = new Promise<string>((resolve) => {
            rl.question("What is your name? ", (answer) => {
                resolve(answer);
            });
        });

        assert.strictEqual(outputData, "What is your name? ");
        input.write("FullStacked\n");

        const answer = await answerPromise;
        assert.strictEqual(answer, "FullStacked");
        rl.close();
    });

    test("question with AbortSignal in readline", async () => {
        const input = new PassThrough();
        const rl = createInterface({
            input,
            terminal: false
        });

        const ac = new AbortController();
        let answered = false;

        rl.question("Name? ", { signal: ac.signal }, () => {
            answered = true;
        });

        ac.abort();
        input.write("Alice\n");
        await new Promise((r) => setTimeout(r, 20));

        assert.strictEqual(answered, false);
        rl.close();
    });

    test("promises.question and signal abort", async () => {
        const input = new PassThrough();
        const rl = createInterfacePromises({
            input,
            terminal: false
        });

        const qPromise = rl.question("Favorite color? ");
        input.write("Blue\n");

        const answer = await qPromise;
        assert.strictEqual(answer, "Blue");

        // Test abort
        const ac = new AbortController();
        const abortedPromise = rl.question("Age? ", { signal: ac.signal });
        ac.abort();

        await assert.rejects(async () => {
            await abortedPromise;
        });

        rl.close();
        await assert.rejects(async () => {
            await rl.question("After close?");
        });
    });

    test("Symbol.dispose", () => {
        const input = new PassThrough();
        const rl = createInterface({ input, terminal: false });
        let closed = false;
        rl.on("close", () => {
            closed = true;
        });
        rl[Symbol.dispose]();
        assert.strictEqual(closed, true);
    });

    test("pause and resume", () => {
        const input = new PassThrough();
        const rl = createInterface({ input, terminal: false });
        let pausedCount = 0;
        let resumedCount = 0;

        rl.on("pause", () => pausedCount++);
        rl.on("resume", () => resumedCount++);

        rl.pause();
        assert.strictEqual(rl.paused, true);
        assert.strictEqual(pausedCount, 1);

        rl.resume();
        assert.strictEqual(rl.paused, false);
        assert.strictEqual(resumedCount, 1);

        rl.close();
    });

    test("terminal mode keypress editing, cursor and history", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let outputBuffer = "";
        output.on("data", (chunk) => {
            outputBuffer += chunk.toString();
        });

        const rl = createInterface({
            input,
            output,
            terminal: true,
            prompt: "$ ",
            historySize: 3,
            removeHistoryDuplicates: true
        });

        rl.prompt();
        assert.strictEqual(rl.getPrompt(), "$ ");
        assert.strictEqual(rl.line, "");
        assert.strictEqual(rl.cursor, 0);

        // Type 'abc'
        rl.write("abc");
        assert.strictEqual(rl.line, "abc");
        assert.strictEqual(rl.cursor, 3);

        // Backspace
        rl.write(null, { name: "backspace" });
        assert.strictEqual(rl.line, "ab");
        assert.strictEqual(rl.cursor, 2);

        // Arrow Left
        rl.write(null, { name: "left" });
        assert.strictEqual(rl.cursor, 1);

        // Insert 'x'
        rl.write("x");
        assert.strictEqual(rl.line, "axb");
        assert.strictEqual(rl.cursor, 2);

        // Home (or Ctrl+A)
        rl.write(null, { ctrl: true, name: "a" });
        assert.strictEqual(rl.cursor, 0);

        // End (or Ctrl+E)
        rl.write(null, { ctrl: true, name: "e" });
        assert.strictEqual(rl.cursor, 3);

        // Enter
        const linePromise1 = new Promise<string>((res) => rl.once("line", res));
        rl.write(null, { name: "return" });
        const line1 = await linePromise1;
        assert.strictEqual(line1, "axb");
        assert.deepStrictEqual(rl.history, ["axb"]);

        // Type another line 'cmd2'
        rl.write("cmd2");
        const linePromise2 = new Promise<string>((res) => rl.once("line", res));
        rl.write(null, { name: "return" });
        await linePromise2;

        assert.deepStrictEqual(rl.history, ["cmd2", "axb"]);

        // History Up
        rl.write(null, { name: "up" });
        assert.strictEqual(rl.line, "cmd2");

        rl.write(null, { name: "up" });
        assert.strictEqual(rl.line, "axb");

        // History Down
        rl.write(null, { name: "down" });
        assert.strictEqual(rl.line, "cmd2");

        rl.write(null, { name: "down" });
        assert.strictEqual(rl.line, "");

        // Test Ctrl+U (clear line)
        rl.write("hello world");
        rl.write(null, { ctrl: true, name: "u" });
        assert.strictEqual(rl.line, "");

        // Test Ctrl+C emits SIGINT
        let sigintEmitted = false;
        rl.on("SIGINT", () => {
            sigintEmitted = true;
        });
        rl.write(null, { ctrl: true, name: "c" });
        assert.strictEqual(sigintEmitted, true);

        rl.close();
    });

    test("autocompletion with completer", () => {
        const input = new PassThrough();
        const output = new PassThrough();

        const rl = createInterface({
            input,
            output,
            terminal: true,
            completer: (line: string) => {
                const completions = ["help", "hello", "quit"];
                const hits = completions.filter((c) => c.startsWith(line));
                return [hits.length ? hits : completions, line];
            }
        });

        rl.write("qui");
        rl.write(null, { name: "tab" });
        assert.strictEqual(rl.line, "quit");

        rl.close();
    });

    test("cursor and screen ANSI functions", () => {
        const output = new PassThrough();
        let written = "";
        output.on("data", (chunk) => {
            written += chunk.toString();
        });

        clearLine(output, 0);
        assert.ok(written.includes("\x1b[2K"));

        clearLine(output, -1);
        assert.ok(written.includes("\x1b[1K"));

        clearLine(output, 1);
        assert.ok(written.includes("\x1b[0K"));

        clearScreenDown(output);
        assert.ok(written.includes("\x1b[0J"));

        cursorTo(output, 10);
        assert.ok(written.includes("\x1b[11G"));

        cursorTo(output, 5, 12);
        assert.ok(written.includes("\x1b[13;6H"));

        moveCursor(output, 2, -3);
        assert.ok(written.includes("\x1b[2C"));
        assert.ok(written.includes("\x1b[3A"));
    });

    test("promises.Readline chaining and commit", async () => {
        const output = new PassThrough();
        let written = "";
        output.on("data", (chunk) => {
            written += chunk.toString();
        });

        const rl = new Readline(output);
        rl.cursorTo(0, 0).clearLine(0).moveCursor(2, 2);

        // Before commit, nothing written
        assert.strictEqual(written, "");

        await rl.commit();
        assert.ok(written.includes("\x1b[1;1H"));
        assert.ok(written.includes("\x1b[2K"));
        assert.ok(written.includes("\x1b[2C"));
        assert.ok(written.includes("\x1b[2B"));

        // Rollback test
        written = "";
        rl.clearScreenDown().rollback();
        await rl.commit();
        assert.strictEqual(written, "");
    });

    test("bundling sample using node:readline and node:readline/promises", async () => {
        const sampleDir = path.join("test", "readline", "sample");
        await fs.promises.mkdir(sampleDir, { recursive: true });
        const sampleFile = path.join(sampleDir, "index.ts");

        await fs.promises.writeFile(
            sampleFile,
            `
import readline from "node:readline";
import { createInterface } from "node:readline/promises";

console.log(typeof readline.createInterface);
console.log(typeof createInterface);
`
        );

        const result = await bundle.bundleFile(sampleFile);
        assert.strictEqual(result.Errors, null);
        assert.ok(result.OutputFiles.length > 0);

        const bundledContent = await fs.promises.readFile(
            result.OutputFiles[0],
            "utf-8"
        );
        assert.ok(bundledContent.includes("Interface"));

        await fs.promises.rm(sampleDir, { recursive: true, force: true });
    });

    test("shell-like terminal stdio with readline", async () => {
        let terminalBuffer = "";
        const mockTerminal = {
            cols: 80,
            rows: 24,
            write(data: string, cb?: () => void) {
                terminalBuffer += data;
                if (cb) cb();
            },
            onResize: () => {}
        };

        class TerminalWriteStream extends EventEmitter {
            isTTY = true;
            private term: any;
            constructor(term: any) {
                super();
                this.term = term;
            }
            get columns() {
                return this.term.cols;
            }
            get rows() {
                return this.term.rows;
            }
            write(chunk: any, encodingOrCallback?: any, callback?: any) {
                const cb =
                    typeof encodingOrCallback === "function"
                        ? encodingOrCallback
                        : callback;
                const str =
                    typeof chunk === "string"
                        ? chunk
                        : new TextDecoder().decode(chunk);
                this.term.write(str, cb);
                return true;
            }
        }

        class TerminalReadStream extends EventEmitter {
            isTTY = true;
            isRaw = false;
            setRawMode(m: boolean) {
                this.isRaw = Boolean(m);
                return this;
            }
            pause() {
                return this;
            }
            resume() {
                return this;
            }
        }

        const stdin = new TerminalReadStream();
        const stdout = new TerminalWriteStream(mockTerminal);

        const rl = createInterfacePromises({ input: stdin, output: stdout });
        const questionPromise = rl.question("What is your name? ");

        assert.ok(terminalBuffer.includes("What is your name? "));
        assert.strictEqual(stdin.isRaw, true);

        stdin.emit("data", Buffer.from("C"));
        stdin.emit("data", Buffer.from("P"));
        stdin.emit("data", Buffer.from("\r"));

        const ans = await questionPromise;
        assert.strictEqual(ans, "CP");
        rl.close();
        assert.strictEqual(stdin.isRaw, false);
    });

    test("waitForInterfaces blocks until rl.close()", async () => {
        const input = new PassThrough();
        const output = new PassThrough();

        const rl = createInterface({ input, output });
        assert.strictEqual(getActiveInterfaces().length, 1);

        let resolved = false;
        const waitPromise = waitForInterfaces().then(() => {
            resolved = true;
        });

        // Yield to event loop: should still be waiting
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(resolved, false);

        rl.close();
        await waitPromise;
        assert.strictEqual(resolved, true);
        assert.strictEqual(getActiveInterfaces().length, 0);
    });

    test("consecutive readline runs on same stream instance (first and second run)", async () => {
        let terminalBuffer = "";
        const mockTerminal = {
            cols: 80,
            rows: 24,
            write(data: string, cb?: () => void) {
                terminalBuffer += data;
                if (cb) cb();
            },
            onResize: () => {}
        };

        const KEYPRESS_DECODER = Symbol.for("KEYPRESS_DECODER");

        class MockShell extends EventEmitter {
            isTTY = true;
            isRaw = false;
            paused = false;

            get columns() {
                return mockTerminal.cols;
            }
            get rows() {
                return mockTerminal.rows;
            }
            setRawMode(mode: boolean) {
                this.isRaw = Boolean(mode);
                if (this.isRaw) this.paused = false;
                return this;
            }
            pause() {
                this.paused = true;
                this.emit("pause");
                return this;
            }
            resume() {
                this.paused = false;
                this.emit("resume");
                return this;
            }
            write(data: any, encodingOrCallback?: any, callback?: any) {
                const cb =
                    typeof encodingOrCallback === "function"
                        ? encodingOrCallback
                        : callback;
                const str =
                    typeof data === "string"
                        ? data
                        : new TextDecoder().decode(data);
                mockTerminal.write(str, cb);
                return true;
            }
            handleInput(e: string) {
                const hasDataListeners =
                    this.listenerCount("data") >
                    ((this as any)[KEYPRESS_DECODER] ? 1 : 0);
                const hasKeypressListeners = this.listenerCount("keypress") > 0;

                if (
                    !this.paused &&
                    (this.isRaw || hasKeypressListeners || hasDataListeners)
                ) {
                    this.emit("data", Buffer.from(e));
                    return true;
                }
                return false; // Handled as shell command
            }
        }

        const shell = new MockShell();

        // Run 1
        const rl1 = createInterfacePromises({ input: shell, output: shell });
        const q1 = rl1.question("Name 1? ");
        assert.strictEqual(shell.isRaw, true);
        assert.strictEqual(shell.handleInput("A"), true);
        assert.strictEqual(shell.handleInput("\r"), true);
        const ans1 = await q1;
        assert.strictEqual(ans1, "A");
        rl1.close();
        assert.strictEqual(shell.isRaw, false);

        // While idle at prompt, typing is shell command (not captured by stdin)
        assert.strictEqual(shell.handleInput("ls\r"), false);

        // Run 2 (second run)
        const rl2 = createInterfacePromises({ input: shell, output: shell });
        const q2 = rl2.question("Name 2? ");
        assert.strictEqual(shell.isRaw, true);
        assert.strictEqual(shell.handleInput("B"), true);
        assert.strictEqual(shell.handleInput("\r"), true);
        const ans2 = await q2;
        assert.strictEqual(ans2, "B");
        rl2.close();
        assert.strictEqual(shell.isRaw, false);

        // Run 3 (third run)
        const rl3 = createInterfacePromises({ input: shell, output: shell });
        const q3 = rl3.question("Name 3? ");
        assert.strictEqual(shell.isRaw, true);
        assert.strictEqual(shell.handleInput("C"), true);
        assert.strictEqual(shell.handleInput("\r"), true);
        const ans3 = await q3;
        assert.strictEqual(ans3, "C");
        rl3.close();
        assert.strictEqual(shell.isRaw, false);
    });
});
