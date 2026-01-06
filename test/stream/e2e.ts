import test, { suite } from "node:test";
import t from "../../core/internal/bundle/lib/test/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import assert from "node:assert";

suite("stream - e2e", () => {
    test("read callback sync", { timeout: 200 }, (_, done) => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(
            new Uint8Array(data),
            intervalMs,
            false
        );

        let streamed = new Uint8Array();
        stream.on("data", (chunk: Uint8Array) => {
            streamed = mergeUint8Arrays(streamed, chunk);
        });
        stream.on("close", () => {
            assert.deepEqual(streamed, data);
            done()
        });
    });

    test("read callback async", { timeout: 200 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(
            new Uint8Array(data),
            intervalMs,
            false
        );

        let streamed = new Uint8Array();
        await new Promise<void>(res => {
            stream.on("data", (chunk: Uint8Array) => {
                streamed = mergeUint8Arrays(streamed, chunk);
            })
            stream.on("close", res)
        });

        assert.deepEqual(streamed, data);
    });

    test("read sync forawait", { timeout: 50 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(
            new Uint8Array(data),
            intervalMs,
            false
        );
        let streamed = new Uint8Array();
        for await (const chunk of stream) {
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
    });

    test("read sync - long forawait", { timeout: 500 }, async () => {
        const intervalMs = 100;
        const data = new Uint8Array([1, 2, 3]);
        const start = Date.now();

        const stream = t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            false
        );

        let streamed = new Uint8Array();
        for await (const chunk of stream) {
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
        assert.ok(Date.now() - start > intervalMs * data.byteLength);
    });

    test("read async forawait", { timeout: 50 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = await t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            true
        );

        let streamed = new Uint8Array();
        for await (const chunk of stream) {
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
    });

    test("read async - long forawait", { timeout: 500 }, async () => {
        const intervalMs = 100;
        const data = new Uint8Array([1, 2, 3]);
        const start = Date.now();

        const stream = await t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            true
        );

        let streamed = new Uint8Array();
        for await (const chunk of stream) {
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
        assert.ok(Date.now() - start > intervalMs * data.byteLength);
    });

    test("write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        const stream = await t.streamWrite(true);
        let streamed = new Uint8Array();

        await new Promise<void>(resolve => {
            stream.on("data", (chunk: Uint8Array) => streamed = mergeUint8Arrays(streamed, chunk));
            stream.on("close", resolve);
            stream.write(data);
            stream.end();
        });

        assert.deepEqual(streamed, data);
    })
});
