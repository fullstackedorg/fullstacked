import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import pg from "pg";
import fs from "node:fs";

import netGo from "../../core/internal/bundle/lib/net/index.ts";
import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import fetchGo from "../../core/internal/bundle/lib/fetch/index.ts";
import gitGo from "../../core/internal/bundle/lib/git/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "../net/server.ts";
import { runContainer, type ServerWorker } from "../server.ts";
import { failWith } from "../listener.ts";
import {
    resetGitServer,
    startGitServer,
    stopGitServer
} from "../git/server.ts";
import {
    startHubServer,
    startSlowUpgradeServer,
    startTunnelServer
} from "./server.ts";
import { payload } from "./payload.ts";
import plugin from "../../core/internal/bundle/lib/plugin/index.ts";

const { Pool } = pg;

suite("tunnel - e2e", () => {
    let tcpServer: ServerWorker;
    let wsTunnelServer: ServerWorker;

    before(async () => {
        tcpServer = await startServer();
        wsTunnelServer = await startTunnelServer(tcpServer.port);

        await tunnelGo.register({
            name: "test-tunnel-e2e",
            host: "localhost",
            port: wsTunnelServer.port,
            unsecure: true
        });
    });

    test("connect through tunnel - single write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise((resolve) => {
            socket.on("connect", () => {
                socket.write(data);
            });
            socket.on("data", (chunk) => {
                received = mergeUint8Arrays(received, chunk);
                if (received.length >= data.length) {
                    socket.destroy();
                }
            });
            socket.on("close", resolve);
            socket.connect(9090, "test-tunnel-e2e");
        });
        assert.deepEqual(received, data);
    });

    // a large write goes to the hub in messages of up to 1 MiB, small writes
    // made meanwhile join in one message, all in order
    test("connect through tunnel - large and small writes, in order", async () => {
        const large = payload(5 * 1024 * 1024 + 7);
        const small = Array.from({ length: 1000 }, (_, i) =>
            Buffer.from(`${i},`)
        );
        const expected = Buffer.concat([large, ...small, large]);

        const socket = new netGo.Socket();
        await new Promise<void>((resolve) => {
            socket.once("connect", resolve);
            socket.connect(9090, "test-tunnel-e2e");
        });
        const chunks: Buffer[] = [];
        let received = 0;
        const echoed = new Promise<void>((resolve) => {
            socket.on("data", (chunk) => {
                chunks.push(chunk);
                received += chunk.byteLength;
                if (received >= expected.byteLength) resolve();
            });
        });
        socket.write(large);
        small.forEach((chunk) => socket.write(chunk));
        socket.write(large);
        await echoed;
        assert.ok(Buffer.concat(chunks).equals(expected));

        await new Promise((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
        });
    });

    test("connect through tunnel - multiple sequential opens", async () => {
        for (let i = 0; i < 3; i++) {
            const data = new Uint8Array([10 + i, 20 + i]);
            let received = new Uint8Array();
            const socket = new netGo.Socket();
            await new Promise((resolve) => {
                socket.on("connect", () => {
                    socket.write(data);
                });
                socket.on("data", (chunk) => {
                    received = mergeUint8Arrays(received, chunk);
                    if (received.length >= data.length) {
                        socket.destroy();
                    }
                });
                socket.on("close", resolve);
                socket.connect(9090, "test-tunnel-e2e");
            });
            assert.deepEqual(received, data);
        }
    });

    test("connect through tunnel - concurrent sockets", async () => {
        const connections = 5;
        const promises = Array.from({ length: connections }).map((_, index) => {
            const data = new Uint8Array([index, index + 10]);
            let received = new Uint8Array();
            const socket = new netGo.Socket();
            return new Promise<void>((resolve, reject) => {
                socket.on("connect", () => {
                    socket.write(data);
                });
                socket.on("data", (chunk) => {
                    received = mergeUint8Arrays(received, chunk);
                    if (received.length >= data.length) {
                        socket.destroy();
                    }
                });
                socket.on("error", reject);
                socket.on(
                    "close",
                    failWith(reject, () => {
                        assert.deepEqual(received, data);
                        resolve();
                    })
                );
                socket.connect(9090, "test-tunnel-e2e");
            });
        });
        await Promise.all(promises);
    });

    test("postgres container tunneling integration", async () => {
        try {
            execSync("docker info", { stdio: "ignore" });
        } catch {
            console.warn(
                "Docker is not running/installed. Skipping postgres container tunnel test."
            );
            return;
        }

        const containerName = `postgres-tunnel-test-${Date.now()}`;

        const pgPort = await runContainer(
            containerName,
            "-e POSTGRES_PASSWORD=testpass postgres:alpine",
            5432
        );
        let pgWsTunnelServer: ServerWorker | null = null;

        try {
            // Wait for Postgres to be fully ready by performing the handshake directly in the ready loop
            let ready = false;
            for (let i = 0; i < 40; i++) {
                const s = new net.Socket();
                const success = await new Promise<boolean>((resolve) => {
                    s.setTimeout(1500);
                    s.on("connect", () => {
                        // Send Postgres SSLRequest message (8 bytes)
                        s.write(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]));
                    });
                    s.on("data", (chunk) => {
                        s.destroy();
                        const resp = String.fromCharCode(chunk[0] as any);
                        resolve(resp === "S" || resp === "N");
                    });
                    s.on("error", () => resolve(false));
                    s.on("close", () => resolve(false));
                    s.on("timeout", () => resolve(false));
                    s.connect(pgPort, "127.0.0.1");
                });
                if (success) {
                    ready = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            assert.ok(
                ready,
                "PostgreSQL container did not become ready in time"
            );

            pgWsTunnelServer = await startTunnelServer(pgPort);

            await tunnelGo.register({
                name: "pg-tunnel-e2e",
                host: "localhost",
                port: pgWsTunnelServer.port,
                unsecure: true
            });

            // 1. Test raw socket handshake through tunnel
            const socket = new netGo.Socket();
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
                socket.connect(5432, "pg-tunnel-e2e");
            });

            const sslRequest = new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]);
            let responseReceived = false;
            let responseByte = "";

            await new Promise<void>((resolve, reject) => {
                socket.on("data", (chunk: Uint8Array) => {
                    responseReceived = true;
                    responseByte = String.fromCharCode(chunk[0]);
                    socket.destroy();
                });
                socket.on("close", () => {
                    resolve();
                });
                socket.on("error", (err) => {
                    reject(err);
                });
                socket.write(sslRequest);
            });

            assert.ok(
                responseReceived,
                "Did not receive handshake response from Postgres"
            );
            assert.ok(
                responseByte === "S" || responseByte === "N",
                `Unexpected Postgres response: ${responseByte}`
            );

            // 2. Test npm pg connection pool queries
            const poolOptions = {
                host: "pg-tunnel-e2e",
                port: 5432,
                user: "postgres",
                password: "testpass",
                database: "postgres",
                stream: () => new netGo.Socket()
            };

            const pool1 = new Pool(poolOptions);

            const res1 = await pool1.query("SELECT 1 + 1 AS result");
            assert.deepEqual(res1.rows[0].result, 2);

            const res2 = await pool1.query("SELECT 2 + 3 AS result");
            assert.deepEqual(res2.rows[0].result, 5);

            await pool1.end();

            // 3. Test reopening: Create a second pool and verify we can run queries again
            const pool2 = new Pool(poolOptions);

            const res3 = await pool2.query("SELECT 3 + 4 AS result");
            assert.deepEqual(res3.rows[0].result, 7);

            await pool2.end();
        } finally {
            if (pgWsTunnelServer) {
                await pgWsTunnelServer.terminate();
            }
            try {
                execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
            } catch {
                // ignore
            }
        }
    });

    test("monotonic stream ID allocation - no immediate reuse on close", async () => {
        const socket1 = new netGo.Socket();
        await new Promise<void>((resolve) => {
            socket1.on("connect", resolve);
            socket1.connect(9090, "test-tunnel-e2e");
        });

        const id1 = socket1.getStreamId();
        assert.ok(
            id1 !== undefined && id1 > 0,
            `Expected valid stream ID, got: ${id1}`
        );

        // Close socket 1
        await new Promise<void>((resolve) => {
            socket1.on("close", resolve);
            socket1.destroy();
        });

        // Open socket 2 immediately
        const socket2 = new netGo.Socket();
        await new Promise<void>((resolve) => {
            socket2.on("connect", resolve);
            socket2.connect(9090, "test-tunnel-e2e");
        });

        const id2 = socket2.getStreamId();
        assert.ok(
            id2 !== undefined && id2 > 0,
            `Expected valid stream ID, got: ${id2}`
        );

        // Assert that stream ID 2 is different from stream ID 1 (it must be monotonically increased/different)
        assert.notEqual(
            id1,
            id2,
            `Stream ID ${id1} was reused immediately after close!`
        );
        assert.equal(id2, id1 + 1, `Expected monotonic stream ID transition`);

        // Clean up
        await new Promise<void>((resolve) => {
            socket2.on("close", resolve);
            socket2.destroy();
        });
    });

    test("connect through tunnel - message larger than 32 KiB", async () => {
        // the websocket library's default read limit is 32 KiB per message,
        // the hub sends up to ~64 KiB per message
        const size = 256 * 1024;
        const hubServer = await startHubServer({ payloadSize: size });

        await tunnelGo.register({
            name: "large-message-tunnel-e2e",
            host: "localhost",
            port: hubServer.port,
            unsecure: true
        });

        try {
            let received = new Uint8Array();
            const socket = new netGo.Socket();
            await new Promise<void>((resolve, reject) => {
                socket.on("error", reject);
                socket.on("data", (chunk) => {
                    received = mergeUint8Arrays(received, chunk);
                    if (received.length >= size) {
                        socket.destroy();
                    }
                });
                socket.on("close", resolve);
                socket.connect(5432, "large-message-tunnel-e2e");
            });
            assert.equal(received.length, size);
            assert.ok(
                Buffer.from(received).equals(payload(size)),
                "large message arrived corrupted"
            );
        } finally {
            await hubServer.terminate();
        }
    });

    test("connect through tunnel - refused dial is a socket error", async () => {
        const hubServer = await startHubServer({ refuseStatus: 401 });

        await tunnelGo.register({
            name: "refused-tunnel-e2e",
            host: "localhost",
            port: hubServer.port,
            unsecure: true
        });

        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);

        try {
            // raw socket: error then close, like node:net
            const socket = new netGo.Socket();
            const events: string[] = [];
            const error = await new Promise<Error>((resolve) => {
                let err: Error;
                socket.on("error", (e) => {
                    events.push("error");
                    err = e;
                });
                socket.on("close", () => {
                    events.push("close");
                    resolve(err);
                });
                socket.on("connect", () => events.push("connect"));
                socket.connect(5432, "refused-tunnel-e2e");
            });
            assert.deepEqual(events, ["error", "close"]);
            assert.ok(error instanceof Error);
            assert.match(error.message, /401/);

            // a driver sees it as a prompt connect rejection
            const client = new pg.Client({
                host: "refused-tunnel-e2e",
                port: 5432,
                user: "postgres",
                password: "testpass",
                database: "postgres",
                stream: () => new netGo.Socket()
            });
            const start = Date.now();
            await assert.rejects(client.connect(), /401/);
            assert.ok(
                Date.now() - start < 5000,
                "pg took too long to see the refused dial"
            );

            // let any stray rejection surface
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", onUnhandled);
            await hubServer.terminate();
        }
    });

    test("connect through tunnel - write synchronously immediately after connect", async () => {
        const data = new Uint8Array([5, 6, 7]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise<void>((resolve, reject) => {
            socket.on("error", reject);
            socket.on("data", (chunk) => {
                received = mergeUint8Arrays(received, chunk);
                if (received.length >= data.length) {
                    socket.destroy();
                }
            });
            socket.on("close", resolve);
            socket.connect(9090, "test-tunnel-e2e");
            socket.write(data);
        });
        assert.deepEqual(received, data);
    });

    // each HTTP connection to a tunnel name is a tunnel connection (DNS, TLS
    // and an upgrade through the hub): concurrent requests reuse them
    // a tunnel connect dials (an upgrade through the hub) off the bridge
    // call: concurrent connects take about one upgrade, and the sockets
    // already open keep their traffic going meanwhile. The dial ran in the
    // call, on the runtime's thread in Node: connects went one at a time and
    // froze every other socket for the length of each upgrade.
    test("concurrent tunnel connects do not wait for each other", async () => {
        const upgradeDelayMs = 150;
        const hub = await startSlowUpgradeServer(upgradeDelayMs);
        await tunnelGo.register({
            name: "slow-upgrade-tunnel-e2e",
            host: "localhost",
            port: hub.port,
            unsecure: true
        });

        const connect = () =>
            new Promise<InstanceType<typeof netGo.Socket>>(
                (resolve, reject) => {
                    const socket = new netGo.Socket();
                    socket.once("connect", () => resolve(socket));
                    socket.once("error", reject);
                    socket.connect(5432, "slow-upgrade-tunnel-e2e");
                }
            );

        const echo = (socket: InstanceType<typeof netGo.Socket>) =>
            new Promise<number>((resolve) => {
                const start = performance.now();
                socket.once("data", () => resolve(performance.now() - start));
                socket.write("ping");
            });

        try {
            const open = await connect();

            // round trips on the open socket while 16 others connect
            let connecting = true;
            const roundTrips: number[] = [];
            const probe = (async () => {
                while (connecting) roundTrips.push(await echo(open));
            })();

            const start = performance.now();
            const sockets = await Promise.all(
                Array.from({ length: 16 }, connect)
            );
            const elapsed = performance.now() - start;
            connecting = false;
            await probe;

            assert.ok(
                elapsed < upgradeDelayMs * 4,
                `16 concurrent connects took ${Math.round(elapsed)} ms`
            );
            assert.ok(
                Math.max(...roundTrips) < upgradeDelayMs / 2,
                `a round trip on an open socket took ${Math.round(Math.max(...roundTrips))} ms during the connects`
            );

            await Promise.all(
                [open, ...sockets].map(
                    (socket) =>
                        new Promise((resolve) => {
                            socket.once("close", resolve);
                            socket.destroy();
                        })
                )
            );
        } finally {
            await hub.terminate();
        }
    });

    test("fetch through tunnel reuses connections", async () => {
        let connections = 0;
        const httpServer = http.createServer((req, res) => {
            setTimeout(() => res.end("ok"), 20);
        });
        httpServer.on("connection", () => connections++);
        await new Promise<void>((resolve) => httpServer.listen(0, resolve));
        const httpPort = (httpServer.address() as any).port;

        const fetchWsTunnelServer = await startTunnelServer(httpPort);
        await tunnelGo.register({
            name: "fetch-reuse-tunnel-e2e",
            host: "localhost",
            port: fetchWsTunnelServer.port,
            unsecure: true
        });

        try {
            const concurrent = 16;
            for (let round = 0; round < 4; round++) {
                const texts = await Promise.all(
                    Array.from({ length: concurrent }, async () => {
                        const response = await fetchGo(
                            "http://fetch-reuse-tunnel-e2e/"
                        );
                        return response.text();
                    })
                );
                assert.ok(texts.every((text) => text === "ok"));
            }
            assert.ok(
                connections <= concurrent + 2,
                `${connections} tunnel connections for ${concurrent} concurrent requests`
            );
        } finally {
            await fetchWsTunnelServer.terminate();
            httpServer.closeAllConnections();
            await new Promise<void>((resolve) =>
                httpServer.close(() => resolve())
            );
        }
    });

    test("fetch through tunnel integration", async () => {
        const httpServer = http.createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("hello from http server");
        });

        await new Promise<void>((resolve) => httpServer.listen(0, resolve));
        const httpPort = (httpServer.address() as any).port;

        const fetchWsTunnelServer = await startTunnelServer(httpPort);

        await tunnelGo.register({
            name: "fetch-tunnel-e2e",
            host: "localhost",
            port: fetchWsTunnelServer.port,
            unsecure: true
        });

        try {
            const response = await fetchGo("http://fetch-tunnel-e2e/test-path");
            assert.equal(response.status, 200);
            const text = await response.text();
            assert.equal(text, "hello from http server");
        } finally {
            await fetchWsTunnelServer.terminate();
            await new Promise<void>((resolve) =>
                httpServer.close(() => resolve())
            );
        }
    });

    test("duplex - write before open", async () => {
        const { Net } =
            await import("../../core/internal/bundle/lib/@types/index.ts");
        const { Connect } =
            await import("../../core/internal/bundle/lib/@types/net.ts");

        const duplex = (await globalThis.fullstacked.bridge({
            mod: Net,
            fn: Connect,
            data: [9090, "test-tunnel-e2e"]
        })) as any;

        // Write to duplex before open() or on('data') is called
        await duplex.write(new Uint8Array([8, 9]));

        // Register data listener to read response and auto-close
        let received = new Uint8Array();
        await new Promise<void>((resolve) => {
            duplex.on("data", (chunk: Uint8Array) => {
                received = mergeUint8Arrays(received, chunk);
                duplex.end();
            });
            duplex.on("close", resolve);
        });

        assert.deepEqual(received, new Uint8Array([8, 9]));
    });

    test("git repository cloning through tunnel integration", async () => {
        try {
            execSync("docker info", { stdio: "ignore" });
        } catch {
            console.warn(
                "Docker is not running/installed. Skipping git container tunnel test."
            );
            return;
        }

        const testCloneDir = "test/tunnel/git-test-repo";
        if (fs.existsSync(testCloneDir)) {
            await fs.promises.rm(testCloneDir, {
                recursive: true,
                force: true
            });
        }

        const gitServer = await startGitServer();
        let gitWsTunnelServer: ServerWorker | null = null;
        // the context keeps one git-auth plugin at most: left registered,
        // the git suite's own fails every authentication
        let gitAuth: Awaited<ReturnType<typeof plugin.register>> | null = null;

        try {
            gitWsTunnelServer = await startTunnelServer(gitServer.port);

            await tunnelGo.register({
                name: "git-tunnel-e2e",
                host: "localhost",
                port: gitWsTunnelServer.port,
                unsecure: true
            });

            // Initialize git auth plugin
            gitAuth = await plugin.register("git-auth", {
                callback: () => ({
                    username: "test",
                    password: "testing"
                })
            });

            // Populate/reset repositories in git-server
            resetGitServer();

            // Clone non-empty repository
            const duplex = await gitGo.clone(
                `${gitServer.origin}/test`,
                testCloneDir,
                { tunnel: "git-tunnel-e2e" }
            );
            await duplex.promise();

            // Verify clone succeeded and files exist
            assert.deepEqual(
                [".git", "test.txt"].sort(),
                fs.readdirSync(testCloneDir).sort()
            );
            assert.deepEqual(
                "test file\n",
                fs.readFileSync(`${testCloneDir}/test.txt`, {
                    encoding: "utf-8"
                })
            );

            // Log commits
            const commits = await gitGo.log(testCloneDir);
            assert.ok(
                commits.length > 0,
                "Expected at least one commit in history"
            );
        } finally {
            await gitAuth?.unregister();
            if (gitWsTunnelServer) {
                await gitWsTunnelServer.terminate();
            }
            if (fs.existsSync(testCloneDir)) {
                await fs.promises.rm(testCloneDir, {
                    recursive: true,
                    force: true
                });
            }
            stopGitServer();
        }
    });

    after(async () => {
        await tcpServer.terminate();
        await wsTunnelServer.terminate();
    });
});
