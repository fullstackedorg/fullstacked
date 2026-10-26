import test, { suite } from "node:test";
import assert from "node:assert";
import child_process from "node:child_process";
import nodeNet from "node:net";
import { WebSocketServer } from "ws";
import net from "../../core/internal/bundle/lib/net/index.ts";

// the CLI from source, validateCommand finds the "fullstacked" token
const cli = ["platform/node/index.ts", "fullstacked"];

type Run = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
};

function spawn(
    args: string[],
    opts?: {
        env?: NodeJS.ProcessEnv;
        // runs once stdout has a line matching, with the output so far
        onOutput?: (stdout: string, child: child_process.ChildProcess) => void;
    }
) {
    return new Promise<Run>((resolve) => {
        const child = child_process.spawn(process.execPath, args, {
            env: opts?.env ?? process.env
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            opts?.onOutput?.(stdout, child);
        });
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (code, signal) =>
            resolve({ code, signal, stdout, stderr })
        );
    });
}

suite("node - fullstacked --file", () => {
    // the script ran past its module settling (before: SIGABRT, exit 134, at
    // the first data of the socket once the core was ended)
    test("keeps running with a socket and an interval, exits on SIGINT", async () => {
        let interrupted = false;
        const run = await spawn(
            [...cli, "-f", "test/node/sample/keep-alive.ts"],
            {
                onOutput(stdout, child) {
                    if (!interrupted && stdout.includes("alive 16s")) {
                        interrupted = true;
                        child.kill("SIGINT");
                    }
                }
            }
        );
        assert.strictEqual(run.signal, null, run.stderr);
        assert.strictEqual(run.code, 0, run.stderr);
        assert.ok(run.stdout.includes("alive 16s, echoes 15"), run.stdout);
    });

    test("exits once the socket closed and the interval cleared", async () => {
        const run = await spawn([
            ...cli,
            "-f",
            "test/node/sample/keep-alive.ts",
            "3"
        ]);
        assert.strictEqual(run.signal, null, run.stderr);
        assert.strictEqual(run.code, 0, run.stderr);
        assert.ok(run.stdout.includes("alive 3s"), run.stdout);
        assert.ok(run.stdout.includes("closed"), run.stdout);
    });

    test("an open socket alone keeps it running", async () => {
        const start = Date.now();
        const run = await spawn([
            ...cli,
            "-f",
            "test/node/sample/keep-alive.ts",
            "2",
            "--no-interval"
        ]);
        assert.strictEqual(run.signal, null, run.stderr);
        assert.strictEqual(run.code, 0, run.stderr);
        assert.ok(run.stdout.includes("closed, echoes 1"), run.stdout);
        assert.ok(Date.now() - start >= 2000);
    });

    test("a failing script exits with its code", async () => {
        const run = await spawn([...cli, "-f", "test/node/sample/missing.ts"]);
        assert.strictEqual(run.signal, null, run.stderr);
        assert.strictEqual(run.code, 1);
    });

    test("keeps the core's globals once its module settled", async () => {
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await new Promise((resolve) => server.once("listening", resolve));
        server.on("connection", (socket) =>
            socket.on("message", (data) => socket.send(`echo ${data}`))
        );
        try {
            const run = await spawn([
                ...cli,
                "-f",
                "test/node/sample/late-globals.ts",
                (server.address() as nodeNet.AddressInfo).port.toString()
            ]);
            assert.strictEqual(run.code, 0, run.stderr);
            assert.ok(run.stdout.includes("same WebSocket: true"), run.stdout);
            assert.ok(run.stdout.includes("window: object"), run.stdout);
            assert.ok(run.stdout.includes("message: echo ping"), run.stdout);
        } finally {
            server.close();
        }
    });

    test("an ended core drops its data and throws on calls", async () => {
        const server = nodeNet.createServer((socket) => socket.pipe(socket));
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve)
        );
        try {
            const port = (server.address() as nodeNet.AddressInfo).port;
            const run = await spawn([
                "test/node/sample/ended-core.ts",
                port.toString()
            ]);
            assert.strictEqual(run.signal, null, run.stderr);
            assert.strictEqual(run.code, 0, run.stderr);
            assert.ok(
                run.stdout.includes("call: the FullStacked core has ended"),
                run.stdout
            );
            assert.ok(run.stdout.includes("still running"), run.stdout);
        } finally {
            server.close();
        }
    });
});

suite("node - net", () => {
    // the core closed the connection: one close, after the end of the data
    async function closes(endFirst: boolean) {
        const server = nodeNet.createServer((socket) => {
            // the core closes both ways on end(), no half-close
            socket.on("error", () => {});
            socket.write("bye");
            socket.end();
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve)
        );
        try {
            const port = (server.address() as nodeNet.AddressInfo).port;
            const socket = net.connect(port, "127.0.0.1");
            const events: string[] = [];
            socket.on("data", (data) => events.push(`data ${data}`));
            socket.on("end", () => events.push("end"));
            socket.on("close", () => events.push("close"));
            if (endFirst) socket.on("data", () => socket.end());
            await new Promise((resolve) => socket.once("close", resolve));
            // a second close would come after the first
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.deepEqual(
                events,
                ["data bye", "end", "close"],
                JSON.stringify(events)
            );
        } finally {
            server.close();
        }
    }

    test("closed by the server: close once", () => closes(false));

    test("ended, then closed by the server: close once", () => closes(true));
});

suite("node - dev server", () => {
    test("--no-open serves without opening the browser", async () => {
        const env = { ...process.env };
        delete env.TEST;
        let url: string;
        let page: Promise<{ status: number; text: string }>;
        const run = await spawn([...cli, "--no-open", "test/node/sample/app"], {
            env,
            onOutput(stdout, child) {
                const listening = /Listening at (http:\/\/\S+)/.exec(stdout);
                if (!listening || url) return;
                url = listening[1];
                page = fetch(url)
                    .then(async (response) => ({
                        status: response.status,
                        text: await response.text()
                    }))
                    .finally(() => child.kill("SIGINT"));
            }
        });
        assert.ok(url, run.stdout + run.stderr);
        const { status, text } = await page;
        assert.strictEqual(status, 200);
        assert.ok(text.includes("<html"), text);
        assert.strictEqual(run.code, 0, run.stderr);
    });
});
