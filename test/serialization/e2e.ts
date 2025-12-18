import test, { suite } from "node:test";
import assert from "node:assert";
import t from "../../core/internal/bundle/lib/test/index.ts";
import {
    BOOLEAN,
    BUFFER,
    NUMBER,
    OBJECT,
    STRING,
    UNDEFINED
} from "../../core/internal/bundle/lib/@types/index.ts";

suite("serialization - e2e", () => {
    test("hello", () => {
        assert.deepEqual(t.hello(), "Hello from go");
    });
    test("serialization", () => {
        assert.deepEqual(t.serialization(undefined), {
            Type: UNDEFINED,
            Data: undefined,
            SizeSerialized: 1
        });
        assert.deepEqual(t.serialization(false), {
            Type: BOOLEAN,
            Data: false,
            SizeSerialized: 2
        });
        assert.deepEqual(t.serialization(1.1), {
            Type: NUMBER,
            Data: 1.1,
            SizeSerialized: 9
        });
        assert.deepEqual(t.serialization("test"), {
            Type: STRING,
            Data: "test",
            SizeSerialized: 9
        });
        assert.deepEqual(t.serialization(new Uint8Array([1, 2, 3])), {
            Type: BUFFER,
            Data: [1, 2, 3],
            SizeSerialized: 8
        });
        assert.deepEqual(t.serialization({ foo: "bar" }), {
            Type: OBJECT,
            Data: { foo: "bar" },
            SizeSerialized: 18
        });
    });

    test("serializationIndex", () => {
        const data = [
            undefined,
            false,
            1.1,
            "test",
            new Uint8Array([1, 2, 3]),
            { foo: "bar" }
        ];
        assert.deepEqual(t.serializationIndex(0, ...data), {
            Type: UNDEFINED,
            Data: undefined,
            SizeSerialized: 1
        });
        assert.deepEqual(t.serializationIndex(1, ...data), {
            Type: BOOLEAN,
            Data: false,
            SizeSerialized: 2
        });
        assert.deepEqual(t.serializationIndex(2, ...data), {
            Type: NUMBER,
            Data: 1.1,
            SizeSerialized: 9
        });
        assert.deepEqual(t.serializationIndex(3, ...data), {
            Type: STRING,
            Data: "test",
            SizeSerialized: 9
        });
        assert.deepEqual(t.serializationIndex(4, ...data), {
            Type: BUFFER,
            Data: [1, 2, 3],
            SizeSerialized: 8
        });
        assert.deepEqual(t.serializationIndex(5, ...data), {
            Type: OBJECT,
            Data: { foo: "bar" },
            SizeSerialized: 18
        });
    });
});
