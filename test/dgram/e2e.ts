import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import dgramGo from "../../core/internal/bundle/lib/dgram/index.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";
import { Buffer } from "buffer";

suite("dgram - e2e", () => {
    let server: Worker;

    before(async () => {
        server = await startServer();
    });

    test("send and receive message", async () => {
        const msg = Buffer.from("hello");
        const socket = dgramGo.createSocket("udp4");

        await new Promise<void>((resolve, reject) => {
            socket.on("message", (reply, rinfo) => {
                assert.deepEqual(reply, Buffer.from("helloACK"));
                assert.equal(rinfo.port, 9091);
                socket.close();
                resolve();
            });

            socket.on("error", reject);

            socket.bind(0, () => {
                socket.send(msg, 9091, "127.0.0.1");
            });
        });
    });

    after(() => {
        server.terminate();
    });
});
