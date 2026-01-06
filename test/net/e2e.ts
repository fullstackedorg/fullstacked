import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import netGo from "../../core/internal/bundle/lib/net/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";



suite("net - e2e", () => {
    let server: Worker;

    before(async () => {
        server = await startServer()
    })

    test("connect - single write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise(resolve => {
            socket.on("connect", () => {
                socket.write(data); 
                setTimeout(socket.destroy.bind(socket), 100);
            })
            socket.on("data", chunk => received = mergeUint8Arrays(received, chunk))
            socket.on("close", resolve)
            socket.connect(9090)
        })
        assert.deepEqual(received, data);
    });

    test("connect - multiple write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise(resolve => {
            socket.on("connect", async () => {
                for(let i = 0; i < data.byteLength; i++) {
                    socket.write(new Uint8Array([data[i]]));
                    await new Promise(res => setTimeout(res, 100));
                }
                socket.destroy();
            })
            socket.on("data", chunk => received = mergeUint8Arrays(received, chunk))
            socket.on("close", resolve)
            socket.connect(9090)
        })
        assert.deepEqual(received, data);
    });

    after(() => {
        server.terminate();
    })
})