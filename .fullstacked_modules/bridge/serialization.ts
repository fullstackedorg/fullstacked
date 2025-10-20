const te = new TextEncoder();
const td = new TextDecoder();

export enum DataType {
    UNDEFINED = 0,
    BOOLEAN = 1,
    STRING = 2,
    NUMBER = 3,
    BUFFER = 4,
    ERROR = 5
}

function serializeNumber(n) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, n);
    return new Uint8Array(view.buffer);
}

function deserializeNumber(bytes: Uint8Array) {
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set(bytes);
    return new DataView(buffer).getFloat64(0);
}

export function numberTo4Bytes(n: number) {
    const uint8Array = new Uint8Array(4);
    uint8Array[0] = (n & 0xff000000) >> 24;
    uint8Array[1] = (n & 0x00ff0000) >> 16;
    uint8Array[2] = (n & 0x0000ff00) >> 8;
    uint8Array[3] = (n & 0x000000ff) >> 0;
    return uint8Array;
}

export function bytesToNumber(bytes: Uint8Array) {
    return (
        ((bytes[0] << 24) |
            (bytes[1] << 16) |
            (bytes[2] << 8) |
            (bytes[3] << 0)) >>>
        0
    );
}

/*

1 byte for type
4 bytes for length
n bytes for data

*/

export function serializeArgs(args: any[]) {
    const parts = args.map((arg) => {
        let data: Uint8Array, type: DataType;
        if (typeof arg === "undefined" || arg === null) {
            type = DataType.UNDEFINED;
            data = new Uint8Array(0);
        } else if (ArrayBuffer.isView(arg)) {
            type = DataType.BUFFER;
            data = new Uint8Array(arg.buffer);
        } else if (typeof arg === "boolean") {
            type = DataType.BOOLEAN;
            data = new Uint8Array([arg ? 1 : 0]);
        } else if (typeof arg === "string") {
            type = DataType.STRING;
            data = te.encode(arg);
        } else if (typeof arg === "number") {
            type = DataType.NUMBER;
            data = serializeNumber(arg);
        } else {
            console.error("Using unknown type with IPC call");
            return null;
        }

        return new Uint8Array([
            type,
            ...numberTo4Bytes(data.byteLength),
            ...data
        ]);
    });

    const totalLength = parts.reduce(
        (total, part) => total + part.byteLength,
        0
    );
    const data = new Uint8Array(totalLength);
    parts.forEach((part, i) => {
        const offset = parts
            .slice(0, i)
            .reduce((total, b) => total + b.byteLength, 0);
        data.set(part, offset);
    });

    return data;
}

export function deserializeArgs(data: Uint8Array) {
    const args: any[] = [];

    let cursor = 0;
    while (cursor < data.byteLength) {
        const type = data[cursor] as DataType;
        cursor += 1;
        const length = bytesToNumber(data.slice(cursor, cursor + 4));
        cursor += 4;
        const arg = data.slice(cursor, cursor + length);
        cursor += length;

        switch (type) {
            case DataType.UNDEFINED:
                args.push(undefined);
                break;
            case DataType.BOOLEAN:
                args.push(arg.at(0) ? true : false);
                break;
            case DataType.STRING:
                args.push(td.decode(arg));
                break;
            case DataType.NUMBER:
                args.push(deserializeNumber(arg));
                break;
            case DataType.BUFFER:
                args.push(arg);
                break;
            case DataType.ERROR:
                throw td.decode(arg);
        }
    }

    return args;
}

export function convertObjectToArray(obj: object) {
    return Object.entries(obj).flat();
}

export function convertArrayToObject(arr: any[]) {
    let obj = {};
    for (let i = 0; i < arr.length; i += 2) {
        obj[arr[i]] = arr[i + 1];
    }
    return obj;
}

export function getLowestKeyIdAvailable(map: Map<number, any>) {
    const currentIds = Array.from(map.keys()).sort((a, b) => a - b);
    let requestId = 0;
    for (const id of currentIds) {
        if (requestId !== id) break;
        requestId++;
    }
    return requestId;
}
