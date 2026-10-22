import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import "../../core/internal/bundle/lib/fetch/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "./server.ts";
import type { ServerWorker } from "../server.ts";
import http from "node:http";
import net from "node:net";

suite("fetch - e2e", () => {
    let worker: ServerWorker = null;
    let origin: string;

    before(async () => {
        worker = await startServer();
        origin = `http://localhost:${worker.port}`;
    });

    test("head", async () => {
        assert.notEqual(fetch, globalThis.fullstacked.fetch);

        const responseNode = await globalThis.fullstacked.fetch(origin);
        const responseGo = await fetch(origin);
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
        const responseNode = await globalThis.fullstacked.fetch(origin);
        let streamedNode = new Uint8Array();
        for await (const chunk of responseNode.body) {
            streamedNode = mergeUint8Arrays(streamedNode, chunk);
        }

        const responseGo = await fetch(origin);
        let streamedGo = new Uint8Array();
        for await (const chunk of responseGo.body) {
            streamedGo = mergeUint8Arrays(streamedGo, chunk);
        }

        assert.deepEqual(streamedNode, streamedGo);
    });

    test("response body - async iterable stream", async () => {
        const responseGo = await fetch(origin);
        const stream = responseGo.body;
        assert.ok(Symbol.asyncIterator in stream);

        let chunkCount = 0;
        let totalSize = 0;
        for await (const chunk of stream) {
            assert.ok(chunk instanceof Uint8Array);
            chunkCount++;
            totalSize += chunk.byteLength;
        }
        assert.ok(chunkCount > 0);
        assert.ok(totalSize > 0);
    });

    // the chunks that came while the reader lagged are merged once by the
    // next read (each chunk merged into the rest was quadratic)
    test("response body - large body read late", async () => {
        const size = 32 * 1024 * 1024;
        const response = await fetch(`${origin}/bytes/${size}`);
        const reader = response.body.getReader();
        // reading started, then the reader lags
        const chunks: Uint8Array[] = [(await reader.read()).value];
        await new Promise((resolve) => setTimeout(resolve, 500));

        const start = performance.now();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const readMs = performance.now() - start;

        const body = mergeUint8Arrays(...chunks);
        assert.equal(body.byteLength, size);
        for (let i = 0; i < size; i += 4099) {
            assert.equal(body[i], i % 251);
        }
        assert.ok(readMs < 5000, `read in ${readMs}ms`);
    });

    // concurrent requests to one host reuse their connections: the pool
    // kept 2 per host, a tunnel name took a new tunnel connection per request
    test("connections are reused across rounds", async () => {
        let connections = 0;
        const server = http.createServer((req, res) => {
            // the requests of a round overlap
            setTimeout(() => res.end("ok"), 20);
        });
        server.on("connection", () => connections++);
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve)
        );
        const port = (server.address() as net.AddressInfo).port;

        try {
            const concurrent = 32;
            for (let round = 0; round < 5; round++) {
                const texts = await Promise.all(
                    Array.from({ length: concurrent }, async () => {
                        const response = await fetch(
                            `http://127.0.0.1:${port}/`
                        );
                        return response.text();
                    })
                );
                assert.ok(texts.every((text) => text === "ok"));
            }
            assert.ok(
                connections <= concurrent + 2,
                `${connections} connections for ${concurrent} concurrent requests`
            );
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test("response body - bytes", async () => {
        const responseNode = await globalThis.fullstacked.fetch(origin);
        const responseGo = await fetch(origin);
        assert.deepEqual(await responseNode.bytes(), await responseGo.bytes());
    });

    test("response body - arraybuffer", async () => {
        const responseNode = await globalThis.fullstacked.fetch(origin);
        const responseGo = await fetch(origin);
        assert.deepEqual(
            await responseNode.arrayBuffer(),
            await responseGo.arrayBuffer()
        );
    });

    test("response body - text", async () => {
        const responseNode = await globalThis.fullstacked.fetch(origin);
        const responseGo = await fetch(origin);
        assert.deepEqual(await responseNode.text(), await responseGo.text());
    });

    test("response body - json", async () => {
        const responseNode = await globalThis.fullstacked.fetch(
            `${origin}/json`
        );
        const jsonNode = await responseNode.json();

        const responseGo = await fetch(`${origin}/json`);
        const jsonGo = await responseGo.json();

        assert.deepEqual(jsonNode, jsonGo);
    });

    test("request body", async () => {
        const body = new Uint8Array([1, 2, 3, 4]);
        const responseGo = await fetch(origin, {
            method: "POST",
            body
        });
        const responseGoBytes = await responseGo.bytes();
        assert.deepEqual(responseGoBytes, body);
        const responseNode = await globalThis.fullstacked.fetch(origin, {
            method: "POST",
            body
        });
        assert.deepEqual(responseGoBytes, await responseNode.bytes());
    });

    test("timeout", { timeout: 1000 }, async () => {
        assert.rejects(
            fetch(`${origin}/wait`, {
                headers: {
                    "x-wait": "2000"
                },
                signal: AbortSignal.timeout(500)
            })
        );
    });

    test("cancel", { timeout: 3000 }, async () => {
        const controller = new AbortController();
        const response = await fetch(`${origin}/stream`, {
            headers: {
                "x-wait": "2000"
            },
            signal: controller.signal
        });
        controller.abort();
        assert.rejects(response.text());
    });

    // a failed request settles: before, the core never ended the stream of
    // a request whose connection failed, and fetch waited forever
    test("refused connection rejects", { timeout: 5000 }, async () => {
        await assert.rejects(fetch("http://localhost:1"), /refused/);
    });

    test(
        "connection dropped before the response rejects",
        { timeout: 5000 },
        async () => {
            await assert.rejects(fetch(`${origin}/drop`), /EOF/);
        }
    );

    test(
        "connection dropped mid-body rejects the body",
        { timeout: 5000 },
        async () => {
            const response = await fetch(`${origin}/cut`);
            assert.equal(response.status, 200);
            let received = 0;
            await assert.rejects(async () => {
                for await (const chunk of response.body) {
                    received += chunk.byteLength;
                }
            }, /unexpected EOF/);
            assert.ok(received > 0 && received < 1024 * 1024);
        }
    );

    test("redirect - follow", async () => {
        const response = await fetch(`${origin}/redirect`);
        assert.deepEqual(response.status, 200);
        assert.deepEqual(response.url, `${origin}/redirect-target`);
        assert.deepEqual(response.redirected, true);
        assert.deepEqual(await response.text(), "redirect target reached");
    });

    test("redirect - manual / false", async () => {
        const responseManual = await fetch(`${origin}/redirect`, {
            redirect: "manual"
        });
        assert.deepEqual(responseManual.status, 302);
        assert.deepEqual(responseManual.url, `${origin}/redirect`);
        assert.deepEqual(responseManual.redirected, false);

        const responseBool = await fetch(`${origin}/redirect`, {
            redirect: false as any
        });
        assert.deepEqual(responseBool.status, 302);
        assert.deepEqual(responseBool.url, `${origin}/redirect`);
        assert.deepEqual(responseBool.redirected, false);
    });

    after(() => {
        worker.terminate();
    });
});
