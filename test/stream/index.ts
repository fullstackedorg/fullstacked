import test, { suite } from "node:test";
import t from "../../lib/test/index.ts";
import { mergeUint8Arrays } from "../../lib/bridge/serialization.ts";
import assert from "node:assert";

suite("stream - e2e", () => {
    test("streaming sync", { timeout: 50 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            false
        );
        let chunksCount = 0,
            streamed = new Uint8Array();
        for await (const chunk of stream) {
            chunksCount++;
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
        assert.deepEqual(chunksCount, 1);
    });

    test("streaming sync - long", { timeout: 500 }, async () => {
        const intervalMs = 100;
        const data = new Uint8Array([1, 2, 3]);
        const start = Date.now();

        const stream = t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            false
        );

        let chunksCount = 0,
            streamed = new Uint8Array();
        for await (const chunk of stream) {
            chunksCount++;
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
        assert.ok(Date.now() - start > intervalMs * data.byteLength);
        assert.deepEqual(chunksCount, 1);
    });

    test("streaming async", { timeout: 50 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = await t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            true
        );

        let chunksCount = 0,
            streamed = new Uint8Array();
        for await (const chunk of stream) {
            chunksCount++;
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
        assert.deepEqual(chunksCount, 4);
    });

    test("streaming async - long", { timeout: 500 }, async () => {
        const intervalMs = 100;
        const data = new Uint8Array([1, 2, 3]);
        const start = Date.now();

        const stream = await t.streaming(
            new Uint8Array([1, 2, 3]),
            intervalMs,
            true
        );

        let chunksCount = 0,
            streamed = new Uint8Array();
        for await (const chunk of stream) {
            chunksCount++;
            streamed = mergeUint8Arrays(streamed, chunk);
        }

        assert.deepEqual(streamed, data);
        assert.ok(Date.now() - start > intervalMs * data.byteLength);
        assert.deepEqual(chunksCount, 4);
    });
});
