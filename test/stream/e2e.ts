import test, { suite } from "node:test";
import t from "../../core/internal/bundle/lib/test/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import assert from "node:assert";
import { Test } from "../../core/internal/bundle/lib/@types/index.ts";
import { BenchStream } from "../../core/internal/bundle/lib/@types/test.ts";

suite("stream - e2e", () => {
    test("read callback sync", { timeout: 200 }, (_, done) => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(new Uint8Array(data), intervalMs, false);

        let streamed = new Uint8Array();
        stream.on("data", (chunk: Uint8Array) => {
            streamed = mergeUint8Arrays(streamed, chunk);
        });
        stream.on("close", () => {
            try {
                assert.deepEqual(streamed, data);
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    test("read callback async", { timeout: 200 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(new Uint8Array(data), intervalMs, false);

        let streamed = new Uint8Array();
        await new Promise<void>((res) => {
            stream.on("data", (chunk: Uint8Array) => {
                streamed = mergeUint8Arrays(streamed, chunk);
            });
            stream.on("close", res);
        });

        assert.deepEqual(streamed, data);
    });

    test("read sync forawait", { timeout: 50 }, async () => {
        const intervalMs = 0;
        const data = new Uint8Array([1, 2, 3]);

        const stream = t.streaming(new Uint8Array(data), intervalMs, false);
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

    // chunks that come while an async reader lags are merged once by its
    // next read: merging each one into the others was quadratic
    test("read async - lagging reader", { timeout: 20000 }, async () => {
        const total = 16 * 1024 * 1024;
        const chunkSize = 1024;
        const stream = await globalThis.fullstacked.bridge({
            mod: Test,
            fn: BenchStream,
            data: [total, chunkSize]
        });
        const iterator = stream[Symbol.asyncIterator]();
        let received = (await iterator.next()).value.byteLength;

        await new Promise((resolve) => setTimeout(resolve, 300));

        const start = performance.now();
        while (true) {
            const { value, done } = await iterator.next();
            if (done) break;
            received += value?.byteLength ?? 0;
        }
        const readMs = performance.now() - start;

        assert.equal(received, total);
        assert.ok(readMs < 2000, `read in ${readMs}ms`);
    });

    test("write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        const stream = await t.streamWrite(true);
        let streamed = new Uint8Array();

        await new Promise<void>((resolve) => {
            stream.on(
                "data",
                (chunk: Uint8Array) =>
                    (streamed = mergeUint8Arrays(streamed, chunk))
            );
            stream.on("close", resolve);
            stream.write(data);
            stream.end();
        });

        assert.deepEqual(streamed, data);
    });
});
