// Randomness from globalThis.crypto.getRandomValues, native in every
// webview and worker (improvements/shim/plan.md 5.1): no core call. getRandomValues
// fills at most 65536 bytes at a time.

import { Buffer } from "buffer";
import {
    BYTES,
    ERR_OUT_OF_RANGE,
    fail,
    invalidArgType,
    validateCallback,
    validateNumber,
    validateObject
} from "./errors.ts";
import { isBytes, toBytes } from "./util.ts";

const MAX = 2 ** 31 - 1;

export function fill(bytes: Uint8Array) {
    // one call for the common small sizes, no view to make
    if (bytes.length <= 65536) {
        globalThis.crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
        return bytes;
    }
    for (let i = 0; i < bytes.length; i += 65536) {
        globalThis.crypto.getRandomValues(
            bytes.subarray(i, i + 65536) as Uint8Array<ArrayBuffer>
        );
    }
    return bytes;
}

// Small requests are served from a pool refilled 4 KB at a time: a
// getRandomValues call costs about the same for 16 bytes as for 4 KB. Each
// pool byte is handed out once.
const pool = new Uint8Array(4096);
let poolOffset = pool.length;

function fillSmall(bytes: Uint8Array) {
    if (bytes.length > 256) return fill(bytes);
    if (poolOffset + bytes.length > pool.length) {
        fill(pool);
        poolOffset = 0;
    }
    bytes.set(pool.subarray(poolOffset, poolOffset + bytes.length));
    poolOffset += bytes.length;
    return bytes;
}

export function randomBytes(size: number, callback?: any) {
    validateNumber(size, "size", 0, MAX);
    if (callback !== undefined) validateCallback(callback);
    const out = fillSmall(Buffer.allocUnsafe(Math.trunc(size)));
    if (callback === undefined) return out;
    queueMicrotask(() => callback(null, out));
}

// the bytes of buf that offset and size (counted in elements) cover
function range(buf: any, offset: any, size: any) {
    if (!isBytes(buf)) {
        throw invalidArgType(
            "buf",
            "an instance of ArrayBuffer or ArrayBufferView",
            buf
        );
    }
    const element = (buf as Uint8Array).BYTES_PER_ELEMENT || 1;
    const length = buf.byteLength;
    // NaN fails the comparison too
    const check = (name: string, value: number, max: number) => {
        if (!(value >= 0 && value <= max)) {
            throw ERR_OUT_OF_RANGE(name, `>= 0 && <= ${max}`, value);
        }
    };
    validateNumber(offset, "offset");
    offset *= element;
    check("offset", offset, length);
    if (size === undefined) {
        size = length - offset;
    } else {
        validateNumber(size, "size");
        size *= element;
        check("size", size, MAX);
        check("size + offset", size + offset, length);
    }
    return toBytes(buf, "buf").subarray(offset, offset + size);
}

export function randomFillSync(buf: any, offset = 0, size?: number) {
    fill(range(buf, offset, size));
    return buf;
}

export function randomFill(buf: any, offset?: any, size?: any, callback?: any) {
    // randomFill(buf, callback) and randomFill(buf, offset, callback)
    if (typeof offset === "function") {
        callback = offset;
        offset = 0;
    } else if (typeof size === "function") {
        callback = size;
        size = undefined;
    }
    const bytes = range(buf, offset, size);
    validateCallback(callback);
    fill(bytes);
    queueMicrotask(() => callback(null, buf));
}

const RAND_MAX = 2 ** 48 - 1;

export function randomInt(min: any, max?: any, callback?: any) {
    const minNotSpecified = max === undefined || typeof max === "function";
    if (minNotSpecified) {
        callback = max;
        max = min;
        min = 0;
    }
    if (callback !== undefined) validateCallback(callback);
    if (!Number.isSafeInteger(min)) {
        throw invalidArgType("min", "a safe integer", min);
    }
    if (!Number.isSafeInteger(max)) {
        throw invalidArgType("max", "a safe integer", max);
    }
    if (max <= min) {
        throw ERR_OUT_OF_RANGE(
            "max",
            `greater than the value of "min" (${min})`,
            max
        );
    }
    const range = max - min;
    if (range > RAND_MAX) {
        throw ERR_OUT_OF_RANGE(
            minNotSpecified ? "max" : "max - min",
            "<= " + RAND_MAX,
            range
        );
    }
    // rejection sampling over 48-bit values, as Node
    const limit = RAND_MAX - (RAND_MAX % range);
    let n: number;
    do {
        n = 0;
        for (const byte of fillSmall(new Uint8Array(6))) n = n * 256 + byte;
    } while (n >= limit);
    const value = min + (n % range);
    if (callback === undefined) return value;
    queueMicrotask(() => callback(null, value));
}

export function randomUUID(options?: any) {
    if (options !== undefined) {
        validateObject(options, "options");
        const { disableEntropyCache: d } = options;
        if (d !== undefined && typeof d !== "boolean") {
            throw invalidArgType(
                "options.disableEntropyCache",
                "of type boolean",
                d
            );
        }
    }
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    // engines without it (pages outside a secure context)
    const b = fill(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return Buffer.from(b)
        .toString("hex")
        .replace(/(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

export const getRandomValues = (array: any) =>
    globalThis.crypto.getRandomValues(array);

export function timingSafeEqual(buf1: any, buf2: any) {
    if (!isBytes(buf1)) throw invalidArgType("buf1", BYTES, buf1);
    if (!isBytes(buf2)) throw invalidArgType("buf2", BYTES, buf2);
    const a = toBytes(buf1, "buf1");
    const b = toBytes(buf2, "buf2");
    if (a.length !== b.length)
        throw fail("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH");
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}
