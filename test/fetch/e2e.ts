import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import "../../core/internal/bundle/lib/fetch/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";

suite("fetch - e2e", () => {
    let worker: Worker = null;

    before(async () => {
        worker = await startServer();
    });

    test("head", async () => {
        assert.notEqual(fetch, globalThis.originalFetch);

        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090"
        );
        const responseGo = await fetch("http://localhost:9090");
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
        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090"
        );
        let streamedNode = new Uint8Array();
        for await (const chunk of responseNode.body) {
            streamedNode = mergeUint8Arrays(streamedNode, chunk);
        }

        const responseGo = await fetch("http://localhost:9090");
        let streamedGo = new Uint8Array();
        for await (const chunk of responseGo.body) {
            streamedGo = mergeUint8Arrays(streamedGo, chunk);
        }

        assert.deepEqual(streamedNode, streamedGo);
    });

    test("response body - bytes", async () => {
        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090"
        );
        const responseGo = await fetch("http://localhost:9090");
        assert.deepEqual(await responseNode.bytes(), await responseGo.bytes());
    });

    test("response body - arraybuffer", async () => {
        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090"
        );
        const responseGo = await fetch("http://localhost:9090");
        assert.deepEqual(
            await responseNode.arrayBuffer(),
            await responseGo.arrayBuffer()
        );
    });

    test("response body - text", async () => {
        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090"
        );
        const responseGo = await fetch("http://localhost:9090");
        assert.deepEqual(await responseNode.text(), await responseGo.text());
    });


    test("response body - json", async () => {
        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090/json"
        );
        const jsonNode = await responseNode.json();

        const responseGo = await fetch("http://localhost:9090/json");
        const jsonGo = await responseGo.json()

        assert.deepEqual(jsonNode, jsonGo);
    })

    test("request body", async () => {
        const body = new Uint8Array([1, 2, 3, 4]);
        const responseGo = await fetch("http://localhost:9090", {
            method: "POST",
            body
        });
        const responseGoBytes = await responseGo.bytes();
        assert.deepEqual(responseGoBytes, body);
        const responseNode = await globalThis.originalFetch(
            "http://localhost:9090",
            {
                method: "POST",
                body
            }
        );
        assert.deepEqual(responseGoBytes, await responseNode.bytes());
    });

    after(() => {
        worker.terminate();
    });
});
