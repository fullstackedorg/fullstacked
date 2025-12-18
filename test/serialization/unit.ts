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
} from "../../core/internal/bundle/lib/bridge/serialization.ts";
import {
    BOOLEAN,
    BUFFER,
    MAX_UINT_4_BYTES,
    NUMBER,
    OBJECT,
    STRING,
    UNDEFINED
} from "../../core/internal/bundle/lib/@types/index.ts";

suite("serialization - unit", () => {
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
            assert.deepStrictEqual(numberToUint4Bytes(dec), arr);
            assert.deepStrictEqual(uint4BytesToNumber(arr), dec);
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

        assert.deepStrictEqual(serializeUndefined(), serialized);
        assert.deepStrictEqual(serialize(undefined), serialized);
        assert.deepStrictEqual(deserializeUndefined(serialized.buffer), {
            data: undefined,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
            data: undefined,
            size: serialized.byteLength
        });

        assert.throws(() => deserializeUndefined(new Uint8Array([1]).buffer));
    });

    test("boolean", () => {
        const bool = false;
        const serialized = new Uint8Array([BOOLEAN, 0]);

        assert.deepStrictEqual(serializeBoolean(bool), serialized);
        assert.deepStrictEqual(serialize(bool), serialized);
        assert.deepStrictEqual(deserializeBoolean(serialized.buffer), {
            data: bool,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
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

        assert.deepStrictEqual(serializeString(str), serialized);
        assert.deepStrictEqual(serialize(str), serialized);
        assert.deepStrictEqual(deserializeString(serialized.buffer), {
            data: str,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
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

        assert.deepStrictEqual(serializeNumber(num), serialized);
        assert.deepStrictEqual(serialize(num), serialized);
        assert.deepStrictEqual(deserializeNumber(serialized.buffer), {
            data: num,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
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

        assert.deepStrictEqual(serializeBuffer(arr), serialized);
        assert.deepStrictEqual(serialize(arr), serialized);
        assert.deepStrictEqual(deserializeBuffer(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
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

        assert.deepStrictEqual(serializeObject(obj), serialized);
        assert.deepStrictEqual(serialize(obj), serialized);
        assert.deepStrictEqual(deserializeObject(serialized.buffer), {
            data: obj,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
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

        assert.deepStrictEqual(serializeObject(arr), serialized);
        assert.deepStrictEqual(serialize(arr), serialized);
        assert.deepStrictEqual(deserializeObject(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });
        assert.deepStrictEqual(deserialize(serialized.buffer), {
            data: arr,
            size: serialized.byteLength
        });
    });

    test("data type switch", () => {
        assert.deepStrictEqual(dataTypeSwitch(undefined), UNDEFINED);
        assert.deepStrictEqual(dataTypeSwitch(false), BOOLEAN);
        assert.deepStrictEqual(dataTypeSwitch(""), STRING);
        assert.deepStrictEqual(dataTypeSwitch(0), NUMBER);
        assert.deepStrictEqual(dataTypeSwitch(new Uint8Array()), BUFFER);
        assert.deepStrictEqual(dataTypeSwitch({}), OBJECT);
        assert.deepStrictEqual(dataTypeSwitch([]), OBJECT);
        assert.deepStrictEqual(dataTypeSwitch(new ArrayBuffer()), null);
    });

    test("merge uint8arrays", () => {
        assert.deepStrictEqual(mergeUint8Arrays(), new Uint8Array());
        assert.deepStrictEqual(
            mergeUint8Arrays(new Uint8Array([0])),
            new Uint8Array([0])
        );
        assert.deepStrictEqual(
            mergeUint8Arrays(new Uint8Array([0]), new Uint8Array([0])),
            new Uint8Array([0, 0])
        );
        assert.throws(() => mergeUint8Arrays(null));
    });

    test("get slice of size from buffer", () => {
        assert.deepStrictEqual(
            getBufferSliceFromSizeData(new Uint8Array([0, 0, 0, 1, 1]).buffer),
            {
                slice: new Uint8Array([1]).buffer,
                size: 5
            }
        );

        assert.deepStrictEqual(
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
