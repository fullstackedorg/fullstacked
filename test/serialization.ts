import test, { suite } from "node:test";
import assert from "node:assert";
import {
    dataTypeSwitch,
    deserialize,
    deserializeBoolean,
    deserializeBuffer,
    deserializeNumber,
    deserializeObject,
    deserializeString,
    deserializeUndefined,
    getBufferSliceFromSizeData,
    mergeUint8Arrays,
    serialize,
    numberToUint4Bytes,
    serializeBoolean,
    serializeBuffer,
    serializeNumber,
    serializeObject,
    serializeString,
    serializeUndefined,
    uint4BytesToNumber
} from "../lib/bridge/serialization.ts";
import {
    BOOLEAN,
    BUFFER,
    MAX_UINT_4_BYTES,
    NUMBER,
    OBJECT,
    STRING,
    UNDEFINED
} from "../lib/@types/index.ts";

suite("bridge serialization", () => {
    test("number / uint 4 bytes", () => {
        const testData = [
            [0, new Uint8Array([0, 0, 0, 0])],
            [1, new Uint8Array([0, 0, 0, 1])],
            [256, new Uint8Array([0, 0, 1, 0])],
            [65536, new Uint8Array([0, 1, 0, 0])],
            [16777216, new Uint8Array([1, 0, 0, 0])],
            [MAX_UINT_4_BYTES, new Uint8Array([255, 255, 255, 255])]
        ] as const;

        for (const [dec, arr] of testData) {
            assert.deepEqual(numberToUint4Bytes(dec), arr);
            assert.deepEqual(uint4BytesToNumber(arr), dec);
        }

        assert.throws(() => numberToUint4Bytes(null));
        assert.throws(() => numberToUint4Bytes(undefined));
        assert.throws(() => numberToUint4Bytes(-1));
        assert.throws(() => numberToUint4Bytes(MAX_UINT_4_BYTES + 1));

        assert.throws(() => uint4BytesToNumber(null));
        assert.throws(() => uint4BytesToNumber(undefined));
        assert.throws(() => uint4BytesToNumber(new Uint8Array([1])));
    });

    test("undefined", () => {
        const serialized = new Uint8Array([UNDEFINED]);

        assert.deepEqual(serializeUndefined(), serialized);
        assert.deepEqual(serialize(undefined), serialized);
        assert.deepEqual(deserializeUndefined(serialized.buffer), {
            data: undefined,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: undefined,
            size: serialized.byteLength
        });

        assert.throws(() => deserializeUndefined(new Uint8Array([1]).buffer));
    });

    test("boolean", () => {
        const bool = false;
        const serialized = new Uint8Array([BOOLEAN, 0]);

        assert.deepEqual(serializeBoolean(bool), serialized);
        assert.deepEqual(serialize(bool), serialized);
        assert.deepEqual(deserializeBoolean(serialized.buffer), {
            data: bool,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: bool,
            size: serialized.byteLength
        });

        assert.throws(() => serializeBoolean(null));
        assert.throws(() => serializeBoolean(undefined));
        assert.throws(() => deserializeBoolean(new Uint8Array([0]).buffer));
    });

    test("string", () => {
        const str = "test";
        const serialized = new Uint8Array([
            STRING,
            ...numberToUint4Bytes(new TextEncoder().encode(str).byteLength),
            ...new TextEncoder().encode(str)
        ]);

        assert.deepEqual(serializeString(str), serialized);
        assert.deepEqual(serialize(str), serialized);
        assert.deepEqual(deserializeString(serialized.buffer), {
            data: str,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: str,
            size: serialized.byteLength
        });

        assert.throws(() => serializeString(null));
        assert.throws(() => serializeString(undefined));
        assert.throws(() => deserializeString(new Uint8Array([0]).buffer));
        assert.throws(() =>
            deserializeString(new Uint8Array([STRING, 0, 0, 0, 1]).buffer)
        );
    });

    test("number", () => {
        const num = 1;
        const serialized = new Uint8Array([NUMBER, 63, 240, 0, 0, 0, 0, 0, 0]);

        assert.deepEqual(serializeNumber(num), serialized);
        assert.deepEqual(serialize(num), serialized);
        assert.deepEqual(deserializeNumber(serialized.buffer), {
            data: num,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: num,
            size: serialized.byteLength
        });

        assert.throws(() => serializeNumber(null));
        assert.throws(() => serializeNumber(undefined));
        assert.throws(() => deserializeNumber(new Uint8Array([0]).buffer));
        assert.throws(() =>
            deserializeNumber(new Uint8Array([NUMBER, 1]).buffer)
        );
    });

    test("buffer / uint8array", () => {
        const arr = new Uint8Array([1, 2, 3, 4]);
        const serialized = new Uint8Array([
            BUFFER,
            ...numberToUint4Bytes(arr.byteLength),
            ...arr
        ]);

        assert.deepEqual(serializeBuffer(arr), serialized);
        assert.deepEqual(serialize(arr), serialized);
        assert.deepEqual(deserializeBuffer(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });

        assert.throws(() => deserializeBuffer(new Uint8Array([0]).buffer));
        assert.throws(() =>
            deserializeBuffer(new Uint8Array([0, 0, 0, 1, 0]).buffer)
        );
        assert.throws(() =>
            deserializeBuffer(new Uint8Array([BUFFER, 0, 0, 0, 1]).buffer)
        );
    });

    test("object", () => {
        const obj = {
            test: "foo"
        };
        const serialized = new Uint8Array([
            OBJECT,
            ...numberToUint4Bytes(
                new TextEncoder().encode(JSON.stringify(obj)).byteLength
            ),
            ...new TextEncoder().encode(JSON.stringify(obj))
        ]);

        assert.deepEqual(serializeObject(obj), serialized);
        assert.deepEqual(serialize(obj), serialized);
        assert.deepEqual(deserializeObject(serialized.buffer), {
            data: obj,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: obj,
            size: serialized.byteLength
        });

        assert.throws(() => serializeObject(null));
        assert.throws(() => serializeObject(undefined));
        assert.throws(() => deserializeObject(new Uint8Array([0]).buffer));
        assert.throws(() =>
            deserializeObject(new Uint8Array([OBJECT, 0, 0, 0, 2, 0, 0]).buffer)
        );
    });

    test("object (array)", () => {
        const arr = [1, 2, 3, 4];
        const serialized = new Uint8Array([
            OBJECT,
            ...numberToUint4Bytes(
                new TextEncoder().encode(JSON.stringify(arr)).byteLength
            ),
            ...new TextEncoder().encode(JSON.stringify(arr))
        ]);

        assert.deepEqual(serializeObject(arr), serialized);
        assert.deepEqual(serialize(arr), serialized);
        assert.deepEqual(deserializeObject(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });
        assert.deepEqual(deserialize(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });
    });

    test("data type switch", () => {
        assert.deepEqual(dataTypeSwitch(undefined), UNDEFINED);
        assert.deepEqual(dataTypeSwitch(false), BOOLEAN);
        assert.deepEqual(dataTypeSwitch(""), STRING);
        assert.deepEqual(dataTypeSwitch(0), NUMBER);
        assert.deepEqual(dataTypeSwitch(new Uint8Array()), BUFFER);
        assert.deepEqual(dataTypeSwitch({}), OBJECT);
        assert.deepEqual(dataTypeSwitch([]), OBJECT);
        assert.deepEqual(dataTypeSwitch(new ArrayBuffer()), null);
    });

    test("merge uint8arrays", () => {
        assert.deepEqual(mergeUint8Arrays(), new Uint8Array());
        assert.deepEqual(
            mergeUint8Arrays(new Uint8Array([0])),
            new Uint8Array([0])
        );
        assert.deepEqual(
            mergeUint8Arrays(new Uint8Array([0]), new Uint8Array([0])),
            new Uint8Array([0, 0])
        );
        assert.throws(() => mergeUint8Arrays(null));
    });

    test("get slice of size from buffer", () => {
        assert.deepEqual(
            getBufferSliceFromSizeData(new Uint8Array([0, 0, 0, 1, 1]).buffer),
            {
                slice: new Uint8Array([1]).buffer,
                size: 5
            }
        );

        assert.deepEqual(
            getBufferSliceFromSizeData(new Uint8Array([0, 0, 0, 0, 1]).buffer),
            {
                slice: new Uint8Array().buffer,
                size: 4
            }
        );

        assert.throws(() =>
            getBufferSliceFromSizeData(new Uint8Array([0, 0, 0, 2, 1]).buffer)
        );
    });
});
