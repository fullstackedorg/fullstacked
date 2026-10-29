import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import netGo from "../../core/internal/bundle/lib/net/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";
import { runContainer, type ServerWorker } from "../server.ts";
import { NodeSSH } from "node-ssh";
import { execSync } from "node:child_process";
import net from "node:net";
import { prepareServer, runMatrix } from "./ssh-algorithms.ts";

suite("net - e2e", () => {
    let server: ServerWorker;
    let containerName: string | null = null;

    before(async () => {
        server = await startServer();
    });

    test("connect - single write", async () => {
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
            socket.connect(server.port);
        });
        assert.deepEqual(received, data);
    });

    test("connect - refused connection is a socket error", async () => {
        // a port nothing listens on
        const closed = net.createServer();
        await new Promise<void>((resolve) => closed.listen(0, resolve));
        const port = (closed.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => closed.close(() => resolve()));

        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);

        try {
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
                socket.connect(port, "127.0.0.1");
            });
            assert.deepEqual(events, ["error", "close"]);
            assert.match(error.message, /refused/);

            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    test("connect - multiple write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise((resolve) => {
            socket.on("connect", async () => {
                for (let i = 0; i < data.byteLength; i++) {
                    socket.write(new Uint8Array([data[i]]));
                    await new Promise((res) => setTimeout(res, 100));
                }
                socket.destroy();
            });
            socket.on(
                "data",
                (chunk) => (received = mergeUint8Arrays(received, chunk))
            );
            socket.on("close", resolve);
            socket.connect(server.port);
        });
        assert.deepEqual(received, data);
    });

    // every socket holds a stream id of the context: a pooled app (database
    // and cache pools, fetches) holds more than one byte of ids at once
    test("connect - more than 255 sockets open at once", async () => {
        const count = 300;
        const sockets = await Promise.all(
            Array.from(
                { length: count },
                () =>
                    new Promise<InstanceType<typeof netGo.Socket>>(
                        (resolve, reject) => {
                            const socket = new netGo.Socket();
                            socket.once("connect", () => resolve(socket));
                            socket.once("error", reject);
                            socket.connect(server.port);
                        }
                    )
            )
        );
        const ids = new Set(sockets.map((s) => s.getStreamId()));
        assert.equal(ids.size, count);
        assert.ok(Math.max(...ids) > 255);

        // each socket gets its own data back, while all are open
        const echoes = await Promise.all(
            sockets.map(
                (socket, i) =>
                    new Promise<string>((resolve) => {
                        const message = `socket ${i}`;
                        let received = "";
                        socket.on("data", (chunk) => {
                            received += chunk.toString();
                            if (received.length >= message.length) {
                                resolve(received);
                            }
                        });
                        socket.write(message);
                    })
            )
        );
        echoes.forEach((echo, i) => assert.equal(echo, `socket ${i}`));

        await Promise.all(
            sockets.map(
                (socket) =>
                    new Promise((resolve) => {
                        socket.once("close", resolve);
                        socket.destroy();
                    })
            )
        );
    });

    // the core writes in order on a goroutine of the socket: before, the
    // write call waited for the peer, on the page's thread in Node
    test("connect - a peer slow to read blocks no other call", async () => {
        const pauseMs = 1000;
        const worker = new Worker("./test/net/server-slow.js", {
            workerData: { pauseMs }
        });
        const port = await new Promise<number>((resolve) =>
            worker.once("message", resolve)
        );

        try {
            const size = 8 * 1024 * 1024;
            const data = new Uint8Array(size);
            for (let i = 0; i < size; i++) data[i] = i % 251;

            const socket = new netGo.Socket();
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
                socket.connect(port, "127.0.0.1");
            });

            const chunks: Uint8Array[] = [];
            let received = 0;
            const echoed = new Promise<void>((resolve) => {
                socket.on("data", (chunk) => {
                    chunks.push(chunk);
                    received += chunk.byteLength;
                    if (received >= size) resolve();
                });
            });

            // the event loop keeps turning while the peer reads nothing
            let last = performance.now();
            let longestGap = 0;
            const interval = setInterval(() => {
                const now = performance.now();
                longestGap = Math.max(longestGap, now - last);
                last = now;
            }, 5);

            const start = performance.now();
            let writtenAfter = 0;
            const written = new Promise<void>((resolve) =>
                socket.write(data, () => {
                    writtenAfter = performance.now() - start;
                    resolve();
                })
            );

            // another socket is not held up either
            const other = new Promise<string>((resolve) => {
                const socket = new netGo.Socket();
                socket.on("data", (chunk) => {
                    resolve(chunk.toString());
                    socket.destroy();
                });
                socket.once("connect", () => socket.write("other"));
                socket.connect(server.port);
            });
            assert.equal(await other, "other");
            assert.ok(
                performance.now() - start < pauseMs / 2,
                "another socket waited for the slow one"
            );

            await Promise.all([written, echoed]);
            clearInterval(interval);

            assert.ok(longestGap < 250, `event loop blocked ${longestGap}ms`);
            // the write callback waits for the core to take the data
            // (backpressure), so after the pause
            assert.ok(
                writtenAfter > pauseMs / 2,
                `written in ${writtenAfter}ms`
            );
            assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), data);

            await new Promise((resolve) => {
                socket.once("close", resolve);
                socket.destroy();
            });
        } finally {
            await worker.terminate();
        }
    });

    // writes made while one is in flight go in one bridge call (_writev)
    test("connect - many small writes, in order, batched", async () => {
        const count = 10000;
        const expected = Buffer.concat(
            Array.from({ length: count }, (_, i) => Buffer.from(`${i},`))
        );

        const bridge = globalThis.fullstacked.bridge;
        let writeCalls = 0;
        globalThis.fullstacked.bridge = ((opts: any, sync?: boolean) => {
            // Stream Write
            if (opts.mod === 1 && opts.fn === 1) writeCalls++;
            return bridge(opts, sync);
        }) as typeof bridge;

        try {
            const socket = new netGo.Socket();
            await new Promise<void>((resolve) => {
                socket.once("connect", resolve);
                socket.connect(server.port);
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
            for (let i = 0; i < count; i++) {
                socket.write(`${i},`);
            }
            await echoed;
            assert.equal(Buffer.concat(chunks).toString(), expected.toString());
            assert.ok(writeCalls < 10, `${writeCalls} write calls`);

            await new Promise((resolve) => {
                socket.once("close", resolve);
                socket.destroy();
            });
        } finally {
            globalThis.fullstacked.bridge = bridge;
        }
    });

    test("ssh", { timeout: 300000 }, async () => {
        containerName = `openssh-server-test-${Date.now()}`;

        // Start openssh-server container with password authentication enabled
        const port = await runContainer(
            containerName,
            "-e PASSWORD_ACCESS=true " +
                "-e USER_NAME=testuser " +
                "-e USER_PASSWORD=testpass " +
                "linuxserver/openssh-server",
            2222
        );

        try {
            // Wait for SSH to be ready by reading the greeting
            let connected = false;
            for (let i = 0; i < 40; i++) {
                const socket = new net.Socket();
                const success = await new Promise<boolean>((resolve) => {
                    let resolved = false;
                    const done = (val: boolean) => {
                        if (resolved) return;
                        resolved = true;
                        socket.destroy();
                        resolve(val);
                    };

                    socket.setTimeout(1500);
                    socket.once("data", (data) => {
                        const str = data.toString();
                        done(str.startsWith("SSH-"));
                    });
                    socket.once("error", () => done(false));
                    socket.once("close", () => done(false));
                    socket.once("timeout", () => done(false));
                    socket.connect(port, "127.0.0.1");
                });
                if (success) {
                    connected = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            assert.ok(connected, "SSH server did not become ready in time");

            // Wait an additional 2 seconds to ensure openssh has started accepting auth requests
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Create netGo.Socket
            const socket = new netGo.Socket();
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
                socket.connect(port, "127.0.0.1");
            });

            // Connect using node-ssh passing the custom socket
            const ssh = new NodeSSH();
            await ssh.connect({
                sock: socket,
                host: "127.0.0.1",
                port: port,
                username: "testuser",
                password: "testpass",
                readyTimeout: 30000
            });

            const result = await ssh.execCommand("echo 'SSH E2E WORKING'");
            assert.deepEqual(result.stdout.trim(), "SSH E2E WORKING");

            ssh.dispose();

            // every cipher, MAC, kex and host key of ssh2, alone, over
            // sockets of the core: what the server accepts with node:crypto
            prepareServer(containerName);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const matrix = await runMatrix(port, async () => {
                const s = new netGo.Socket();
                await new Promise<void>((resolve, reject) => {
                    s.once("connect", resolve);
                    s.once("error", reject);
                    s.connect(port, "127.0.0.1");
                });
                return s;
            });
            // what the server must accept (the ones SSH_MATRIX keeps)
            for (const name of [
                "cipher aes128-gcm@openssh.com",
                "cipher aes128-ctr",
                "mac hmac-sha2-256",
                "kex curve25519-sha256",
                "host key ssh-ed25519",
                "compress zlib@openssh.com"
            ]) {
                if (name in matrix) assert.equal(matrix[name], "ok", name);
            }
        } finally {
            if (containerName) {
                try {
                    execSync(`docker rm -f ${containerName}`, {
                        stdio: "ignore"
                    });
                } catch {
                    // ignore
                }
                containerName = null;
            }
        }
    });

    after(() => {
        server.terminate();
        if (containerName) {
            try {
                execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
            } catch {
                // ignore
            }
        }
    });
});
