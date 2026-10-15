// Bytes in and out of the crypto API: Node takes strings in an encoding,
// ArrayBuffers and every view, and returns Buffers or encoded strings.

import { Buffer } from "buffer";
import { invalidArgType, invalidArgValue, STRING_OR_BYTES } from "./errors.ts";

export const EMPTY = new Uint8Array(0);

// a Buffer over the same memory, results of the core and of the TS
// primitives are fresh arrays nobody else holds
export const toBuffer = (bytes: Uint8Array) =>
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const isBytes = (
    value: unknown
): value is ArrayBuffer | ArrayBufferView =>
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer);

export const isStringOrBytes = (value: unknown) =>
    typeof value === "string" || isBytes(value);

// Node's getArrayBufferOrView; an unknown encoding reads as UTF-8, as in
// Node's C++ side
export function toBytes(
    data: any,
    name: string,
    encoding?: string,
    expected = STRING_OR_BYTES
): Uint8Array {
    if (typeof data === "string") {
        if (encoding === "hex" && data.length % 2 !== 0) {
            throw invalidArgValue(
                "encoding",
                encoding,
                `is invalid for data of length ${data.length}`
            );
        }
        return Buffer.from(
            data,
            Buffer.isEncoding(encoding) ? (encoding as BufferEncoding) : "utf8"
        );
    }
    if (ArrayBuffer.isView(data)) {
        return data instanceof Uint8Array
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (isBytes(data)) return new Uint8Array(data as ArrayBuffer);
    throw invalidArgType(name, expected, data);
}

export function encode(bytes: Uint8Array, encoding?: string): any {
    const buffer = toBuffer(bytes);
    return encoding && encoding !== "buffer"
        ? buffer.toString(encoding as BufferEncoding)
        : buffer;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 1) return chunks[0];
    let size = 0;
    for (const chunk of chunks) size += chunk.length;
    const out = new Uint8Array(size);
    size = 0;
    for (const chunk of chunks) {
        out.set(chunk, size);
        size += chunk.length;
    }
    return out;
}
