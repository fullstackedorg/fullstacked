import test, { suite } from "node:test";
import t from "../../core/internal/bundle/lib/test/index.ts";
import assert from "node:assert";

suite("events - e2e", () => {
    test("emit", async () => {
        const data = [
            undefined,
            false,
            "string",
            2,
            new Uint8Array([1, 2, 3]),
            { foo: "testing" }
        ];

        const received = [];
        await new Promise<void>((res) => {
            const emitter = t.eventEmitter(0, ...data);
            emitter.on("event", received.push.bind(received));
            emitter.duplex.on("close", res);
        });
        assert.deepStrictEqual(data, received);
    });

    test("emit - slow", async () => {
        const data = [
            undefined,
            false,
            "string",
            2,
            new Uint8Array([1, 2, 3]),
            { foo: "testing" }
        ];

        const received = [];
        await new Promise<void>((res) => {
            const emitter = t.eventEmitter(100, ...data);
            emitter.on("event", received.push.bind(received));
            emitter.duplex.on("close", res);
        });
        assert.deepStrictEqual(data, received);
    });
});
