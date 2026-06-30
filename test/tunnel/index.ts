import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { execSync } from "node:child_process";
import net from "node:net";
import pg from "pg";
import fs from "node:fs";

import netGo from "../../core/internal/bundle/lib/net/index.ts";
import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import gitGo from "../../core/internal/bundle/lib/git/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "../net/server.ts";
import { startTunnelServer } from "./server.ts";
import { Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import plugin from "../../core/internal/bundle/lib/plugin/index.ts";

const { Pool } = pg;

suite("tunnel - e2e", () => {
    let tcpServer: Worker;
    let wsTunnelServer: Worker;

    before(async () => {
        tcpServer = await startServer();
        wsTunnelServer = await startTunnelServer(9091, 9090);

        await tunnelGo.register({
            name: "test-tunnel-e2e",
            host: "localhost",
            port: 9091,
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
                setTimeout(socket.destroy.bind(socket), 100);
            });
            socket.on(
                "data",
                (chunk) => (received = mergeUint8Arrays(received, chunk))
            );
            socket.on("close", resolve);
            socket.connect(9090, "test-tunnel-e2e");
        });
        assert.deepEqual(received, data);
    });

    test("connect through tunnel - multiple sequential opens", async () => {
        for (let i = 0; i < 3; i++) {
            const data = new Uint8Array([10 + i, 20 + i]);
            let received = new Uint8Array();
            const socket = new netGo.Socket();
            await new Promise((resolve) => {
                socket.on("connect", () => {
                    socket.write(data);
                    setTimeout(socket.destroy.bind(socket), 100);
                });
                socket.on(
                    "data",
                    (chunk) => (received = mergeUint8Arrays(received, chunk))
                );
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
            return new Promise<void>((resolve) => {
                socket.on("connect", () => {
                    socket.write(data);
                    setTimeout(socket.destroy.bind(socket), 100);
                });
                socket.on(
                    "data",
                    (chunk) => (received = mergeUint8Arrays(received, chunk))
                );
                socket.on("close", () => {
                    assert.deepEqual(received, data);
                    resolve();
                });
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

        execSync(
            `docker run -d --name ${containerName} ` +
                `-e POSTGRES_PASSWORD=testpass ` +
                `-p 127.0.0.1::5432 ` +
                `postgres:alpine`,
            { stdio: "pipe" }
        );

        let pgPort = 0;
        let pgWsTunnelServer: Worker | null = null;

        try {
            const portOutput = execSync(`docker port ${containerName} 5432`, {
                encoding: "utf8"
            }).trim();
            const match = portOutput.match(/:(\d+)$/);
            if (!match) {
                throw new Error(`Failed to parse pg port: ${portOutput}`);
            }
            pgPort = parseInt(match[1], 10);

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

            pgWsTunnelServer = await startTunnelServer(9092, pgPort);

            await tunnelGo.register({
                name: "pg-tunnel-e2e",
                host: "localhost",
                port: 9092,
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
        assert.equal(
            id2,
            (id1 % 255) + 1,
            `Expected monotonic stream ID transition`
        );

        // Clean up
        await new Promise<void>((resolve) => {
            socket2.on("close", resolve);
            socket2.destroy();
        });
    });

    test("connect through tunnel - write synchronously immediately after connect", async () => {
        const data = new Uint8Array([5, 6, 7]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise<void>((resolve, reject) => {
            socket.on("error", reject);
            socket.on(
                "data",
                (chunk) => (received = mergeUint8Arrays(received, chunk))
            );
            socket.on("close", resolve);
            socket.connect(9090, "test-tunnel-e2e");
            socket.write(data);
            setTimeout(() => {
                socket.destroy();
            }, 100);
        });
        assert.deepEqual(received, data);
    });

    test("duplex - write before open", async () => {
        const { bridge } =
            await import("../../core/internal/bundle/lib/bridge/index.ts");
        const { Net } =
            await import("../../core/internal/bundle/lib/@types/index.ts");
        const { Connect } =
            await import("../../core/internal/bundle/lib/@types/net.ts");

        const duplex = (await bridge({
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

        // Start git-server docker compose
        execSync("docker compose up --build -d", {
            cwd: "test/git/local-git-server",
            stdio: "ignore"
        });

        const gitWsTunnelServer = await startTunnelServer(9093, 8080);

        await tunnelGo.register({
            name: "git-tunnel-e2e",
            host: "localhost",
            port: 9093,
            unsecure: true
        });

        // Initialize git auth plugin
        await plugin.register("git-auth", {
            callback: () => ({
                username: "test",
                password: "testing"
            })
        });

        const testCloneDir = "test/tunnel/git-test-repo";
        if (fs.existsSync(testCloneDir)) {
            await fs.promises.rm(testCloneDir, {
                recursive: true,
                force: true
            });
        }

        try {
            // Populate/reset repositories in git-server
            execSync(
                "docker compose exec git-server /bin/bash /home/setup.sh",
                {
                    cwd: "test/git/local-git-server",
                    stdio: "ignore"
                }
            );

            // Clone non-empty repository
            const duplex = await gitGo.clone(
                "http://localhost:8080/test",
                testCloneDir,
                "git-tunnel-e2e"
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
            if (gitWsTunnelServer) {
                await gitWsTunnelServer.terminate();
            }
            if (fs.existsSync(testCloneDir)) {
                await fs.promises.rm(testCloneDir, {
                    recursive: true,
                    force: true
                });
            }
            // Stop git-server docker compose
            try {
                execSync("docker compose down", {
                    cwd: "test/git/local-git-server",
                    stdio: "ignore"
                });
            } catch {
                // ignore
            }
        }
    });

    after(async () => {
        await tcpServer.terminate();
        await wsTunnelServer.terminate();
    });
});

suite("tunnel - integration", () => {
    let browser: Browser;
    let tcpServer: Worker;
    let wsTunnelServer: Worker;

    before(async () => {
        tcpServer = await startServer();
        wsTunnelServer = await startTunnelServer(9091, 9090);
        browser = await createBrowser("test/tunnel/sample/basic");
    });

    test("socket connection through registered tunnel in browser", async () => {
        const result = await bundle.bundle("test/tunnel/sample/basic/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);

        const page = await browser.createPage();
        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const content = await page.getTextContent("body");
            assert.deepEqual(content, "789");
        };

        await test();
    });

    after(async () => {
        await browser.end();
        await tcpServer.terminate();
        await wsTunnelServer.terminate();
    });
});
