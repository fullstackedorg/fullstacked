import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { type ServerWorker, startWorkerServer } from "../server.ts";

import netGo from "../../core/internal/bundle/lib/net/index.ts";
import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import fetchGo from "../../core/internal/bundle/lib/fetch/index.ts";
import { payload } from "./payload.ts";

// Concurrent large transfers through tunnels, like a bench of S3 GetObject,
// with database sockets opening and closing alongside and some transfers
// losing their connection. Every transfer must settle: whole, or with an
// error. Before, a request whose connection dropped waited forever while both
// ends of the connection were already closed.

const objectSize = 4 * 1024 * 1024;
const expected = payload(objectSize);

function startStressServer() {
    return startWorkerServer("./test/tunnel/server-stress.js");
}

// rejects instead of waiting forever on a stalled transfer
function withTimeout<T>(promise: Promise<T>, label: string) {
    const ms = 30_000;
    let timeout: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timeout = setTimeout(
                () => reject(new Error(`${label} stalled for ${ms}ms`)),
                ms
            );
        })
    ]).finally(() => clearTimeout(timeout));
}

async function getObject(path = `${objectSize}`) {
    const response = await fetchGo(`http://stress-http/${path}`);
    assert.equal(response.status, 200);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body as any) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// connect, one round trip, close: a database client's lifetime
function echoCycle() {
    return new Promise<void>((resolve, reject) => {
        const data = payload(1024);
        let received = 0;
        const socket = new netGo.Socket();
        socket.on("error", reject);
        socket.on("connect", () => socket.write(data));
        socket.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received >= data.byteLength) {
                socket.destroy();
            }
        });
        socket.on("close", () => {
            if (received >= data.byteLength) resolve();
            else reject(new Error("echo socket closed early"));
        });
        socket.connect(5432, "stress-echo");
    });
}

suite("tunnel - stress", () => {
    let server: ServerWorker;

    before(async () => {
        server = await startStressServer();
        await tunnelGo.register({
            name: "stress-http",
            host: "localhost",
            port: server.port,
            unsecure: true
        });
        await tunnelGo.register({
            name: "stress-echo",
            host: "localhost",
            port: server.port,
            path: "/echo",
            unsecure: true
        });
    });

    after(() => server?.terminate());

    test("concurrent large transfers settle with socket churn and dropped connections", async () => {
        const transfers = Array.from({ length: 16 }, async (_, w) => {
            for (let i = 0; i < 6; i++) {
                const label = `worker ${w} GET ${i}`;
                if ((w + i) % 4 === 1) {
                    await withTimeout(
                        assert.rejects(getObject(`drop/${objectSize}`)),
                        `${label} (dropped)`
                    );
                } else if ((w + i) % 4 === 3) {
                    await withTimeout(
                        assert.rejects(getObject(`cut/${objectSize}`)),
                        `${label} (cut)`
                    );
                } else {
                    const body = await withTimeout(getObject(), label);
                    assert.equal(body.byteLength, objectSize);
                    assert.ok(body.equals(expected), `${label} corrupted`);
                }
            }
        });

        const churn = Array.from({ length: 4 }, async (_, c) => {
            for (let i = 0; i < 40; i++) {
                await withTimeout(echoCycle(), `churn ${c} cycle ${i}`);
            }
        });

        await Promise.all([...transfers, ...churn]);
    });

    // Stream ids are one byte (1-255) per context. A stream whose producer
    // never ended kept its id for good: failed requests did, and once all
    // ids were taken the core searched for a free one forever on the
    // runtime's thread. Hundreds of short-lived streams, some abandoned,
    // then many open at once.
    test("short-lived and abandoned streams do not exhaust stream ids", async () => {
        for (let i = 0; i < 300; i++) {
            await withTimeout(
                assert.rejects(getObject(`drop/${objectSize}`)),
                `dropped GET ${i}`
            );
        }

        for (let i = 0; i < 300; i++) {
            await withTimeout(echoCycle(), `echo cycle ${i}`);
        }

        // closed by the app mid-transfer
        for (let i = 0; i < 50; i++) {
            await withTimeout(
                new Promise<void>((resolve, reject) => {
                    const socket = new netGo.Socket();
                    socket.on("error", reject);
                    socket.on("connect", () => socket.write(payload(1 << 20)));
                    socket.once("data", () => socket.destroy());
                    socket.on("close", () => resolve());
                    socket.connect(5432, "stress-echo");
                }),
                `abandoned socket ${i}`
            );
        }

        // destroyed while connecting
        for (let i = 0; i < 60; i++) {
            const socket = new netGo.Socket();
            socket.connect(5432, "stress-echo");
            socket.destroy();
        }
        await new Promise((resolve) => setTimeout(resolve, 500));

        // many at once: fails when the streams above kept their ids
        const sockets = await withTimeout(
            Promise.all(
                Array.from(
                    { length: 200 },
                    () =>
                        new Promise<InstanceType<typeof netGo.Socket>>(
                            (resolve, reject) => {
                                const socket = new netGo.Socket();
                                socket.on("error", reject);
                                socket.on("connect", () => resolve(socket));
                                socket.connect(5432, "stress-echo");
                            }
                        )
                )
            ),
            "200 open sockets"
        );
        await Promise.all(
            sockets.map(
                (socket) =>
                    new Promise((resolve) => {
                        socket.on("close", resolve);
                        socket.destroy();
                    })
            )
        );
    });
});
