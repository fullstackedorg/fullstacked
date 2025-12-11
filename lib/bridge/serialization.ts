import {
    BOOLEAN,
    BUFFER,
    DataType,
    MAX_UINT_4_BYTES,
    NUMBER,
    OBJECT,
    STRING,
    UNDEFINED
} from "../@types/serialization.ts";

/*

Serializing Data

1 byte for type
4 bytes for length
n bytes for data

*/

export function numberToUint4Bytes(num: number) {
    if (num < 0) {
        throw new Error("cannot convert negative number to uint 4 bytes");
    }

    if (num > MAX_UINT_4_BYTES) {
        throw new Error("converting too high number to uint 4 bytes");
    }

    if (num === null || num === undefined) {
        throw new Error("received null/undefined");
    }

    const uint8Array = new Uint8Array(4);
    uint8Array[0] = (num & 0xff000000) >> 24;
    uint8Array[1] = (num & 0x00ff0000) >> 16;
    uint8Array[2] = (num & 0x0000ff00) >> 8;
    uint8Array[3] = (num & 0x000000ff) >> 0;
    return uint8Array;
}

export function uint4BytesToNumber(bytes: Uint8Array) {
    if (bytes === null || bytes === undefined) {
        throw new Error("cant convert null/undefined to number");
    }

    if (bytes.byteLength !== 4) {
        throw new Error("uint8array for uint 4 bytes must be of size 4");
    }

    return (
        ((bytes[0] << 24) |
            (bytes[1] << 16) |
            (bytes[2] << 8) |
            (bytes[3] << 0)) >>>
        0
    );
}

export function serializeUndefined() {
    return new Uint8Array([UNDEFINED]);
}

export function deserializeUndefined(buffer: ArrayBuffer, index = 0) {
    if (new DataView(buffer).getUint8(index) !== UNDEFINED) {
        throw new Error("wrong data type for undefined");
    }

    return { data: undefined, size: 1 };
}

export function serializeBoolean(bool: boolean) {
    if (bool === null || bool === undefined) {
        throw new Error("cannot serialize null or undefined as bool");
    }
    return new Uint8Array([BOOLEAN, bool ? 1 : 0]);
}

export function deserializeBoolean(buffer: ArrayBuffer, index = 0) {
    if (new DataView(buffer).getUint8(index) !== BOOLEAN) {
        throw new Error("wrong data type for boolean");
    }

    const data = new DataView(buffer).getUint8(index + 1);
    if (data !== 1 && data !== 0) {
        throw new Error(
            `wrong boolean representation. should be 1 or 0. have [${data}]`
        );
    }

    return { data, size: 2 };
}

const te = new TextEncoder();
const td = new TextDecoder();

export function serializeString(str: string) {
    if (str === null || str === undefined) {
        throw new Error("cannot serialize null or undefined as string");
    }

    const buffer = te.encode(str);

    if (buffer.byteLength > MAX_UINT_4_BYTES) {
        throw new Error("serializing too long string");
    }

    const serialize = new Uint8Array(buffer.byteLength + 5);
    serialize.set([STRING], 0);
    serialize.set(numberToUint4Bytes(buffer.byteLength), 1);
    serialize.set(buffer, 5);
    return serialize;
}

export function deserializeString(buffer: ArrayBuffer, index = 0) {
    if (new DataView(buffer).getUint8(index) !== STRING) {
        throw new Error("wrong data type for string");
    }

    index++;
    const { slice, size } = getBufferSliceFromSizeData(buffer, index);

    return { data: td.decode(slice), size: size + 1 };
}

export function serializeNumber(num: number) {
    if (num === null || num === undefined) {
        throw new Error("cannot serialize null or undefined as number");
    }

    const buffer = new ArrayBuffer(9);
    const view = new DataView(buffer);
    view.setInt8(0, NUMBER);
    view.setFloat64(1, num);
    return new Uint8Array(buffer);
}

export function deserializeNumber(buffer: ArrayBuffer, index = 0) {
    if (new DataView(buffer).getUint8(index) !== NUMBER) {
        throw new Error("wrong data type for number");
    }

    if (index + 9 > buffer.byteLength) {
        throw new Error("buffer length too short to get number");
    }

    const view = new DataView(buffer, index + 1, 8);
    return {
        data: view.getFloat64(0),
        size: 9
    };
}

export function serializeBuffer(arr: Uint8Array) {
    if (arr.byteLength > MAX_UINT_4_BYTES) {
        throw new Error("serializing too long buffer");
    }

    const serialize = new Uint8Array(arr.byteLength + 5);
    serialize.set([BUFFER], 0);
    serialize.set(numberToUint4Bytes(arr.byteLength), 1);
    serialize.set(arr, 5);
    return serialize;
}

export function deserializeBuffer(buffer: ArrayBuffer, index = 0) {
    if (new DataView(buffer).getUint8(index) !== BUFFER) {
        throw new Error("wrong data type for buffer");
    }

    index++;
    const { slice, size } = getBufferSliceFromSizeData(buffer, index);

    return { data: new Uint8Array(slice), size: size + 1 };
}

export function serializeObject(obj: object) {
    if (obj === null || obj === undefined) {
        throw new Error("cannot serialize null or undefined as object");
    }

    const jsonStr = JSON.stringify(obj);
    const buffer = te.encode(jsonStr);
    const serialize = new Uint8Array(buffer.byteLength + 5);
    serialize.set([OBJECT], 0);
    serialize.set(numberToUint4Bytes(buffer.byteLength), 1);
    serialize.set(buffer, 5);
    return serialize;
}
export function deserializeObject(buffer: ArrayBuffer, index = 0) {
    if (new DataView(buffer).getUint8(index) !== OBJECT) {
        throw new Error("wrong data type for object");
    }

    index++;
    const { slice, size } = getBufferSliceFromSizeData(buffer, index);

    const jsonStr = td.decode(slice);
    return { data: JSON.parse(jsonStr), size: size + 1 };
}

export function getBufferSliceFromSizeData(buffer: ArrayBuffer, index = 0) {
    const size = uint4BytesToNumber(
        new Uint8Array(buffer.slice(index, index + 4))
    );
    index += 4;

    if (index + size > buffer.byteLength) {
        throw new Error(
            "buffer length too short to get slice of expected size"
        );
    }

    return {
        slice: buffer.slice(index, index + size),
        size: size + 4
    };
}

export type Data = string | boolean | number | Uint8Array | object | null;

export function dataTypeSwitch(data: Data): DataType {
    if (typeof data === "undefined" || data === null) {
        return UNDEFINED;
    } else if (typeof data === "boolean") {
        return BOOLEAN;
    } else if (typeof data === "string") {
        return STRING;
    } else if (typeof data === "number") {
        return NUMBER;
    } else if (typeof data === "object") {
        if (
            data.constructor.name === "Object" ||
            data.constructor.name === "Array"
        )
            return OBJECT;
        else if (data instanceof Uint8Array) return BUFFER;
    }

    return null;
}

export function serialize(data: Data): Uint8Array<ArrayBuffer> {
    const type = dataTypeSwitch(data);

    if (type === null) {
        throw new Error("trying to serialize unknow data type");
    }

    switch (type) {
        case UNDEFINED:
            return serializeUndefined();
        case BUFFER:
            return serializeBuffer(data as Uint8Array);
        case BOOLEAN:
            return serializeBoolean(data as boolean);
        case STRING:
            return serializeString(data as string);
        case NUMBER:
            return serializeNumber(data as number);
        case OBJECT:
            return serializeObject(data as object);
    }

    return null;
}

export function mergeUint8Arrays(...arrays: Uint8Array[]) {
    if (arrays.find((arr) => !(arr instanceof Uint8Array))) {
        throw new Error("cannot merge anything other than Uint8Array");
    }

    const length = arrays.reduce((total, arr) => total + arr.length, 0);
    const merged = new Uint8Array(length);
    let offset = 0;
    for (let i = 0; i < arrays.length; i++) {
        const arr = arrays[i];
        merged.set(arr, offset);
        offset += arr.byteLength;
    }
    return merged;
}

export function deserializeData(buffer: ArrayBuffer, index = 0) {
    const type = new DataView(buffer).getUint8(index) as DataType;
    switch (type) {
        case UNDEFINED:
            return deserializeUndefined(buffer, index);
        case BUFFER:
            return deserializeBuffer(buffer, index);
        case BOOLEAN:
            return deserializeBoolean(buffer, index);
        case STRING:
            return deserializeString(buffer, index);
        case NUMBER:
            return deserializeNumber(buffer, index);
        case OBJECT:
            return deserializeObject(buffer, index);
    }
}

export function deserialize(buffer: ArrayBuffer): Data[] {
    const data: Data[] = [];
    let index = 0;
    while (index < buffer.byteLength) {
        const deserialized = deserializeData(buffer, index);
        data.push(deserialized.data);
        index += deserialized.size;
    }

    return data;
}
