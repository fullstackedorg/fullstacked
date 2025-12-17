import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { fetch as goFetch } from "../../lib/fetch/index.ts";
import { Worker } from "node:worker_threads";
import { mergeUint8Arrays } from "../../lib/bridge/serialization.ts";

function startServer() {
    return new Promise<Worker>((res) => {
        const worker = new Worker("./test/fetch/server.js");
        worker.on("message", () => res(worker));
        worker.on("error", console.log);
    });
}

suite("fetch - e2e", () => {
    let worker: Worker = null;
    before(async () => {
        worker = await startServer();
    });

    test("head", async () => {
        const responseNode = await fetch("http://localhost:9000");
        const responseGo = await goFetch("http://localhost:9000");
        assert.deepEqual(responseNode.ok, responseGo.ok);
        assert.ok(!!responseNode.headers.get("x-header-test"));
        assert.deepEqual(
            responseNode.headers.get("x-header-test"),
            responseGo.headers.get("x-header-test")
        );
        assert.deepEqual(responseNode.status, responseGo.status);
        assert.deepEqual(responseNode.statusText, responseGo.statusText);
    });

    test("response body - stream", async () => {
        const responseNode = await fetch("http://localhost:9000");
        let streamedNode = new Uint8Array();
        for await (const chunk of responseNode.body) {
            streamedNode = mergeUint8Arrays(streamedNode, chunk);
        }

        const responseGo = await goFetch("http://localhost:9000");
        let streamedGo = new Uint8Array();
        for await (const chunk of responseGo.body) {
            streamedGo = mergeUint8Arrays(streamedGo, chunk);
        }

        assert.deepEqual(streamedNode, streamedGo);
    });

    test("response body - bytes", async () => {
        const responseNode = await fetch("http://localhost:9000");
        const responseGo = await goFetch("http://localhost:9000");
        assert.deepEqual(await responseNode.bytes(), await responseGo.bytes());
    });

    test("response body - arraybuffer", async () => {
        const responseNode = await fetch("http://localhost:9000");
        const responseGo = await goFetch("http://localhost:9000");
        assert.deepEqual(
            await responseNode.arrayBuffer(),
            await responseGo.arrayBuffer()
        );
    });

    test("response body - text", async () => {
        const responseNode = await fetch("http://localhost:9000");
        const responseGo = await goFetch("http://localhost:9000");
        assert.deepEqual(await responseNode.text(), await responseGo.text());
    });

    test("request body", async () => {
        const body = new Uint8Array([1, 2, 3, 4]);
        const responseGo = await goFetch("http://localhost:9000", {
            method: "POST",
            body
        });
        const responseGoBytes = await responseGo.bytes();
        assert.deepEqual(responseGoBytes, body);
        const responseNode = await fetch("http://localhost:9000", {
            method: "POST",
            body
        });
        assert.deepEqual(responseGoBytes, await responseNode.bytes());
    });

    after(async () => {
        worker.terminate();
    });
});
