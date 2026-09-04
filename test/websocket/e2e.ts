import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import WebSocketCore from "../../core/internal/bundle/lib/websocket/index.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";

suite("websocket - e2e", () => {
    let worker: Worker = null;

    before(async () => {
        worker = await startServer();
    });

    test("original WebSocket preserved", () => {
        assert.ok(
            globalThis.fullstacked.WebSocket,
            "globalThis.fullstacked.WebSocket must exist"
        );
    });

    test("connect and send text", async () => {
        const ws = new WebSocketCore("ws://localhost:9092");
        assert.equal(ws.readyState, WebSocketCore.CONNECTING);

        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => {
                assert.equal(ws.readyState, WebSocketCore.OPEN);
                ws.send("hello core websocket");
            };

            ws.onmessage = (event) => {
                assert.equal(event.data, "hello core websocket");
                ws.close(1000, "client done");
            };

            ws.onclose = (event) => {
                assert.equal(ws.readyState, WebSocketCore.CLOSED);
                assert.equal(event.code, 1000);
                resolve();
            };

            ws.onerror = (err) => {
                reject(err);
            };
        });
    });

    test("send and receive binary arraybuffer", async () => {
        const ws = new WebSocketCore("ws://localhost:9092");
        ws.binaryType = "arraybuffer";

        await new Promise<void>((resolve, reject) => {
            const sendBytes = new Uint8Array([10, 20, 30, 40, 50]);

            ws.onopen = () => {
                ws.send(sendBytes);
            };

            ws.onmessage = (event) => {
                assert.ok(
                    event.data instanceof ArrayBuffer,
                    "expected ArrayBuffer"
                );
                const receivedBytes = new Uint8Array(event.data);
                assert.deepEqual(receivedBytes, sendBytes);
                ws.close(1000);
            };

            ws.onclose = () => {
                resolve();
            };

            ws.onerror = (err) => {
                reject(err);
            };
        });
    });

    test("send and receive binary blob", async () => {
        const ws = new WebSocketCore("ws://localhost:9092");
        ws.binaryType = "blob";

        await new Promise<void>((resolve, reject) => {
            const sendBytes = new Uint8Array([100, 101, 102]);

            ws.onopen = () => {
                ws.send(sendBytes);
            };

            ws.onmessage = async (event) => {
                assert.ok(event.data instanceof Blob, "expected Blob");
                const buf = await event.data.arrayBuffer();
                assert.deepEqual(new Uint8Array(buf), sendBytes);
                ws.close(1000);
            };

            ws.onclose = () => {
                resolve();
            };

            ws.onerror = (err) => {
                reject(err);
            };
        });
    });

    test("server initiated close", async () => {
        const ws = new WebSocketCore("ws://localhost:9092");

        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => {
                ws.send("close-4001");
            };

            ws.onclose = (event) => {
                assert.equal(event.code, 4001);
                assert.equal(event.reason, "custom-close");
                assert.equal(ws.readyState, WebSocketCore.CLOSED);
                resolve();
            };

            ws.onerror = (err) => {
                reject(err);
            };
        });
    });

    test("connect error on unavailable port", async () => {
        const ws = new WebSocketCore("ws://localhost:59999");

        await new Promise<void>((resolve) => {
            let hadError = false;
            ws.onerror = () => {
                hadError = true;
            };

            ws.onclose = (event) => {
                assert.ok(hadError, "expected error event before close");
                assert.equal(event.code, 1006);
                assert.equal(event.wasClean, false);
                assert.equal(ws.readyState, WebSocketCore.CLOSED);
                resolve();
            };
        });
    });

    test("invalid url schemes throw SyntaxError", () => {
        assert.throws(() => {
            new WebSocketCore("ftp://localhost:9092");
        }, /SyntaxError/);
    });

    test("send before open throws InvalidStateError", () => {
        const ws = new WebSocketCore("ws://localhost:9092");
        assert.throws(() => {
            ws.send("too early");
        }, /InvalidStateError/);
        ws.close();
    });

    after(() => {
        worker.terminate();
    });
});
