// node:buffer, from Node 22's lib/buffer.js and lib/internal/buffer.js: the
// same design (a `Buffer` function whose prototype is the one of an internal
// `FastBuffer extends Uint8Array`, so instances are plain Uint8Arrays), the
// same argument handling and errors. What Node does in C++ (the encodings,
// fill, indexOf, compare) is in TypeScript here and in ./codecs.ts, over
// TextEncoder/TextDecoder and the engine's base64/hex when it has them.
//
// Not reproduced: the 8 KB allocation pool (every Buffer owns its
// ArrayBuffer, which the bridge and postMessage callers rely on), zero-fill
// toggles (allocUnsafe is zero-filled), deprecation warnings.

import {
    asciiSlice,
    base64ByteLength,
    base64Slice,
    base64ToBytes,
    base64Write,
    hexSlice,
    hexToBytes,
    hexWrite,
    isAsciiRange,
    latin1Slice,
    latin1Write,
    LITTLE_ENDIAN,
    normalizeEncoding,
    ucs2Slice,
    ucs2Write,
    utf8ByteLength,
    utf8Encode,
    utf8Slice,
    utf8Write
} from "./codecs.ts";
import {
    ERR_BUFFER_OUT_OF_BOUNDS,
    ERR_INDEX_OUT_OF_RANGE,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_BUFFER_SIZE,
    ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE,
    ERR_UNKNOWN_ENCODING,
    transcodeError,
    validateInteger,
    validateNumber,
    validateOffset
} from "./errors.ts";

// V8's limits on 64-bit, what Node 22 reports
export const kMaxLength = 2 ** 53 - 1;
export const kStringMaxLength = 2 ** 29 - 24;
export const constants = {
    MAX_LENGTH: kMaxLength,
    MAX_STRING_LENGTH: kStringMaxLength
};
export let INSPECT_MAX_BYTES = 50;

const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

// the Uint8Array methods Buffer overrides, for its own use
const u8Fill = Uint8Array.prototype.fill;
const u8IndexOf = Uint8Array.prototype.indexOf;
const u8LastIndexOf = Uint8Array.prototype.lastIndexOf;
const u8Set = Uint8Array.prototype.set;
const u8Subarray = Uint8Array.prototype.subarray;

// typed over ArrayBuffer like Uint8Array's default; the views made over a
// SharedArrayBuffer are cast
class FastBuffer extends Uint8Array {}

// a Buffer over the memory of a Uint8Array
function wrap(bytes: Uint8Array): FastBuffer {
    return new FastBuffer(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.length
    );
}

function isUint8Array(value: unknown): value is Uint8Array {
    return (
        value instanceof Uint8Array ||
        (ArrayBuffer.isView(value) &&
            (value as Uint8Array)[Symbol.toStringTag] === "Uint8Array")
    );
}

// the TypedArray toStringTag getter is undefined on a DataView's prototype
// chain, which has its own "DataView" tag
function isTypedArray(value: unknown): value is Uint8Array {
    if (!ArrayBuffer.isView(value)) return false;
    const tag: string = (value as Uint8Array)[Symbol.toStringTag];
    return tag !== undefined && tag !== "DataView";
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength"
).get;
const sharedArrayBufferByteLength =
    typeof SharedArrayBuffer === "function"
        ? Object.getOwnPropertyDescriptor(
              SharedArrayBuffer.prototype,
              "byteLength"
          ).get
        : null;

// ArrayBuffer or SharedArrayBuffer, from any realm
function isAnyArrayBuffer(value: unknown): value is ArrayBufferLike {
    if (value instanceof ArrayBuffer) return true;
    if (
        typeof value !== "object" ||
        value === null ||
        ArrayBuffer.isView(value) ||
        Array.isArray(value)
    ) {
        return false;
    }
    // the byteLength getters check the brand
    for (const byteLength of [
        arrayBufferByteLength,
        sharedArrayBufferByteLength
    ]) {
        if (!byteLength) continue;
        try {
            byteLength.call(value);
            return true;
        } catch {}
    }
    return false;
}

// Encodings

interface EncodingOps {
    ucs2: boolean;
    byteLength(string: string): number;
    from(string: string): FastBuffer;
    write(buf: Uint8Array, string: string, offset: number, max: number): number;
    slice(buf: Uint8Array, start: number, end: number): string;
    // the needle a string is searched as
    needle(string: string): Uint8Array;
}

function fromWriter(
    write: EncodingOps["write"],
    length: (string: string) => number
) {
    return (string: string) => {
        const buf = new FastBuffer(length(string));
        const written = write(buf, string, 0, buf.length);
        return written === buf.length
            ? buf
            : new FastBuffer(buf.buffer, 0, written);
    };
}

const utf8Ops: EncodingOps = {
    ucs2: false,
    byteLength: utf8ByteLength,
    from: (string) => wrap(utf8Encode(string)),
    write: utf8Write,
    slice: utf8Slice,
    needle: utf8Encode
};

const ucs2Ops: EncodingOps = {
    ucs2: true,
    byteLength: (string) => string.length * 2,
    from: fromWriter(ucs2Write, (string) => string.length * 2),
    write: ucs2Write,
    slice: ucs2Slice,
    needle: (string) => ucs2Ops.from(string)
};

const latin1Ops: EncodingOps = {
    ucs2: false,
    byteLength: (string) => string.length,
    from: fromWriter(latin1Write, (string) => string.length),
    write: latin1Write,
    slice: latin1Slice,
    needle: (string) => latin1Ops.from(string)
};

const asciiOps: EncodingOps = {
    ...latin1Ops,
    slice: asciiSlice,
    needle: (string) => asciiOps.from(string)
};

const hexFromWriter = fromWriter(hexWrite, (string) => string.length >>> 1);
const hexOps: EncodingOps = {
    ucs2: false,
    byteLength: (string) => string.length >>> 1,
    from: (string) => {
        const bytes = hexToBytes(string);
        return bytes ? wrap(bytes) : hexFromWriter(string);
    },
    write: hexWrite,
    slice: hexSlice,
    needle: (string) => hexOps.from(string)
};

const base64FromWriter = fromWriter(base64Write, base64ByteLength);
function makeBase64Ops(url: boolean): EncodingOps {
    const ops: EncodingOps = {
        ucs2: false,
        byteLength: base64ByteLength,
        from: (string) => {
            const bytes = base64ToBytes(string, url);
            return bytes ? wrap(bytes) : base64FromWriter(string);
        },
        write: base64Write,
        slice: (buf, start, end) => base64Slice(buf, start, end, url),
        needle: (string) => ops.from(string)
    };
    return ops;
}
const base64Ops = makeBase64Ops(false);
const base64urlOps = makeBase64Ops(true);

const ENCODING_OPS: Record<string, EncodingOps> = Object.assign(
    Object.create(null),
    {
        utf8: utf8Ops,
        "utf-8": utf8Ops,
        ucs2: ucs2Ops,
        "ucs-2": ucs2Ops,
        utf16le: ucs2Ops,
        "utf-16le": ucs2Ops,
        latin1: latin1Ops,
        binary: latin1Ops,
        ascii: asciiOps,
        hex: hexOps,
        base64: base64Ops,
        base64url: base64urlOps
    }
);

function getEncodingOps(encoding: unknown): EncodingOps | undefined {
    const name = `${encoding}`;
    return ENCODING_OPS[name] ?? ENCODING_OPS[name.toLowerCase()];
}

// Creation

function fromString(string: string, encoding: unknown): FastBuffer {
    let ops: EncodingOps;
    if (typeof encoding !== "string" || encoding.length === 0) {
        if (string.length === 0) return new FastBuffer();
        ops = utf8Ops;
    } else {
        ops = getEncodingOps(encoding);
        if (ops === undefined) throw ERR_UNKNOWN_ENCODING(encoding);
        if (string.length === 0) return new FastBuffer();
    }
    return ops.from(string);
}

function fromArrayBuffer(
    obj: ArrayBufferLike,
    byteOffset: unknown,
    length: unknown
): FastBuffer {
    let offset: number;
    if (byteOffset === undefined) {
        offset = 0;
    } else {
        offset = +byteOffset;
        if (Number.isNaN(offset)) offset = 0;
    }

    const maxLength = obj.byteLength - offset;
    if (maxLength < 0) throw ERR_BUFFER_OUT_OF_BOUNDS("offset");

    // undefined: to the end, from the truncated offset
    let size: number;
    if (length !== undefined) {
        size = +length;
        if (size > 0) {
            if (size > maxLength) throw ERR_BUFFER_OUT_OF_BOUNDS("length");
        } else {
            size = 0;
        }
    }
    return new FastBuffer(obj as ArrayBuffer, offset, size);
}

// small array-likes are copied by index (Node copies them into its pool with
// TypedArray#set), larger ones through the constructor, which iterates
function fromArrayLike(obj: ArrayLike<number>): FastBuffer {
    if (obj.length <= 0) return new FastBuffer();
    if (obj.length < Buffer.poolSize >>> 1) {
        const buf = new FastBuffer(obj.length);
        buf.set(obj);
        return buf;
    }
    return new FastBuffer(obj);
}

function fromObject(obj: any): FastBuffer | undefined {
    if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
        if (typeof obj.length !== "number") return new FastBuffer();
        return fromArrayLike(obj);
    }
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
        return fromArrayLike(obj.data);
    }
}

function from(
    value: unknown,
    encodingOrOffset?: unknown,
    length?: unknown
): FastBuffer {
    if (typeof value === "string") return fromString(value, encodingOrOffset);

    if (typeof value === "object" && value !== null) {
        if (isAnyArrayBuffer(value)) {
            return fromArrayBuffer(value, encodingOrOffset, length);
        }

        const valueOf = (value as any).valueOf?.();
        if (
            valueOf != null &&
            valueOf !== value &&
            (typeof valueOf === "string" || typeof valueOf === "object")
        ) {
            return from(valueOf, encodingOrOffset, length);
        }

        const buf = fromObject(value);
        if (buf) return buf;

        const toPrimitive = (value as any)[Symbol.toPrimitive];
        if (typeof toPrimitive === "function") {
            const primitive = toPrimitive.call(value, "string");
            if (typeof primitive === "string") {
                return fromString(primitive, encodingOrOffset);
            }
        }
    }

    throw ERR_INVALID_ARG_TYPE(
        "first argument",
        ["string", "Buffer", "ArrayBuffer", "Array", "Array-like Object"],
        value
    );
}

function alloc(size: number, fill?: unknown, encoding?: unknown) {
    validateNumber(size, "size", 0, kMaxLength);
    if (fill !== undefined && fill !== 0 && size > 0) {
        return fillBuffer(new FastBuffer(size), fill, 0, size, encoding);
    }
    return new FastBuffer(size);
}

function allocUnsafe(size: number) {
    validateNumber(size, "size", 0, kMaxLength);
    return new FastBuffer(size);
}

function byteLength(string: unknown, encoding?: unknown): number {
    if (typeof string !== "string") {
        if (ArrayBuffer.isView(string) || isAnyArrayBuffer(string)) {
            return string.byteLength;
        }
        throw ERR_INVALID_ARG_TYPE(
            "string",
            ["string", "Buffer", "ArrayBuffer"],
            string
        );
    }
    if (string.length === 0) return 0;
    if (!encoding || encoding === "utf8") return utf8ByteLength(string);
    if (encoding === "ascii") return string.length;
    // Node falls back to utf8 for an unknown encoding here
    return (getEncodingOps(encoding) ?? utf8Ops).byteLength(string);
}

function concat(list: readonly Uint8Array[], length?: number) {
    if (!Array.isArray(list)) throw ERR_INVALID_ARG_TYPE("list", "Array", list);
    if (list.length === 0) return new FastBuffer();

    const total = length === undefined;
    if (total) length = 0;
    else validateOffset(length, "length");
    for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        if (!isUint8Array(buf)) {
            throw ERR_INVALID_ARG_TYPE(
                `list[${i}]`,
                ["Buffer", "Uint8Array"],
                buf
            );
        }
        if (total) length += buf.length;
    }

    // a `length` above the total leaves zeros at the end
    const buffer = new FastBuffer(length);
    let pos = 0;
    for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        const end = pos + buf.length;
        if (end > length) {
            u8Set.call(buffer, u8Subarray.call(buf, 0, length - pos), pos);
            break;
        }
        u8Set.call(buffer, buf, pos);
        pos = end;
    }
    return buffer;
}

function copyBytesFrom(view: unknown, offset?: number, length?: number) {
    if (!isTypedArray(view)) {
        throw ERR_INVALID_ARG_TYPE("view", ["TypedArray"], view);
    }
    const viewLength = view.length;
    if (viewLength === 0) return new FastBuffer();

    let start = 0;
    let end = viewLength;
    if (offset !== undefined) {
        validateInteger(offset, "offset", 0);
        if (offset >= viewLength) return new FastBuffer();
        start = offset;
    }
    if (length !== undefined) {
        validateInteger(length, "length", 0);
        end = Math.min(start + length, viewLength);
    }
    if (end <= start) return new FastBuffer();

    const elementSize = view.byteLength / viewLength;
    return fromArrayLike(
        new Uint8Array(
            view.buffer,
            view.byteOffset + start * elementSize,
            (end - start) * elementSize
        )
    );
}

function compare(buf1: Uint8Array, buf2: Uint8Array) {
    if (!isUint8Array(buf1)) {
        throw ERR_INVALID_ARG_TYPE("buf1", ["Buffer", "Uint8Array"], buf1);
    }
    if (!isUint8Array(buf2)) {
        throw ERR_INVALID_ARG_TYPE("buf2", ["Buffer", "Uint8Array"], buf2);
    }
    if (buf1 === buf2) return 0;
    return compareBytes(buf1, 0, buf1.length, buf2, 0, buf2.length);
}

// memcmp of the common length, then the longer is greater
function compareBytes(
    a: Uint8Array,
    aStart: number,
    aEnd: number,
    b: Uint8Array,
    bStart: number,
    bEnd: number
) {
    const aLength = aEnd - aStart;
    const bLength = bEnd - bStart;
    const length = Math.min(aLength, bLength);
    let i = 0;
    // four bytes at a time when both ranges are aligned for it
    if (
        length >= 32 &&
        ((a.byteOffset + aStart) & 3) === 0 &&
        ((b.byteOffset + bStart) & 3) === 0
    ) {
        const words = length >>> 2;
        const wa = new Int32Array(a.buffer, a.byteOffset + aStart, words);
        const wb = new Int32Array(b.buffer, b.byteOffset + bStart, words);
        let w = 0;
        while (w < words && wa[w] === wb[w]) w++;
        i = w * 4;
    }
    for (; i < length; i++) {
        const x = a[aStart + i];
        const y = b[bStart + i];
        if (x !== y) return x < y ? -1 : 1;
    }
    return aLength > bLength ? 1 : aLength < bLength ? -1 : 0;
}

function copyActual(
    source: ArrayBufferView,
    target: ArrayBufferView,
    targetStart: number,
    sourceStart: number,
    sourceEnd: number
) {
    if (sourceEnd - sourceStart > target.byteLength - targetStart) {
        sourceEnd = sourceStart + target.byteLength - targetStart;
    }
    let nb = sourceEnd - sourceStart;
    const sourceLength = source.byteLength - sourceStart;
    if (nb > sourceLength) nb = sourceLength;
    if (nb <= 0) return 0;

    if (sourceStart === 0 && nb === sourceLength && isUint8Array(target)) {
        // element-wise, as Node does it (the same as bytes for a Uint8Array)
        target.set(source as Uint8Array, targetStart);
    } else {
        // bytes, like memmove: TypedArray#set clones an overlapping source
        new Uint8Array(target.buffer, target.byteOffset + targetStart, nb).set(
            new Uint8Array(source.buffer, source.byteOffset + sourceStart, nb)
        );
    }
    return nb;
}

function toInteger(n: unknown, defaultValue: number) {
    const value = +n;
    if (
        !Number.isNaN(value) &&
        value >= Number.MIN_SAFE_INTEGER &&
        value <= Number.MAX_SAFE_INTEGER
    ) {
        return value % 1 === 0 ? value : Math.floor(value);
    }
    return defaultValue;
}

function copy(
    source: ArrayBufferView,
    target: ArrayBufferView,
    targetStart?: unknown,
    sourceStart?: unknown,
    sourceEnd?: unknown
) {
    if (!ArrayBuffer.isView(source)) {
        throw ERR_INVALID_ARG_TYPE("source", ["Buffer", "Uint8Array"], source);
    }
    if (!ArrayBuffer.isView(target)) {
        throw ERR_INVALID_ARG_TYPE("target", ["Buffer", "Uint8Array"], target);
    }

    let tStart = 0;
    if (targetStart !== undefined) {
        tStart = Number.isInteger(targetStart)
            ? (targetStart as number)
            : toInteger(targetStart, 0);
        if (tStart < 0) {
            throw ERR_OUT_OF_RANGE("targetStart", ">= 0", targetStart);
        }
    }

    let sStart = 0;
    if (sourceStart !== undefined) {
        sStart = Number.isInteger(sourceStart)
            ? (sourceStart as number)
            : toInteger(sourceStart, 0);
        if (sStart < 0 || sStart > source.byteLength) {
            throw ERR_OUT_OF_RANGE(
                "sourceStart",
                `>= 0 && <= ${source.byteLength}`,
                sourceStart
            );
        }
    }

    let sEnd = source.byteLength;
    if (sourceEnd !== undefined) {
        sEnd = Number.isInteger(sourceEnd)
            ? (sourceEnd as number)
            : toInteger(sourceEnd, 0);
        if (sEnd < 0) throw ERR_OUT_OF_RANGE("sourceEnd", ">= 0", sourceEnd);
    }

    if (tStart >= target.byteLength || sStart >= sEnd) return 0;
    return copyActual(source, target, tStart, sStart, sEnd);
}

// fill

function fillBuffer(
    buf: FastBuffer,
    value: unknown,
    offset: unknown,
    end: unknown,
    encoding: unknown
): FastBuffer {
    let normalized: string;
    if (typeof value === "string") {
        if (offset === undefined || typeof offset === "string") {
            encoding = offset;
            offset = 0;
            end = buf.length;
        } else if (typeof end === "string") {
            encoding = end;
            end = buf.length;
        }

        normalized = normalizeEncoding(encoding);
        if (normalized === undefined) {
            if (typeof encoding !== "string") {
                throw ERR_INVALID_ARG_TYPE("encoding", "string", encoding);
            }
            throw ERR_UNKNOWN_ENCODING(encoding);
        }

        if (value.length === 0) {
            // an empty string fills with zeros
            value = 0;
        } else if (value.length === 1) {
            // a single character that is a single byte
            if (normalized === "utf8" || normalized === "ascii") {
                const code = value.charCodeAt(0);
                if (code < 128) value = code;
            } else if (normalized === "latin1") {
                value = value.charCodeAt(0);
            }
        }
    }

    let start: number;
    let stop: number;
    if (offset === undefined) {
        start = 0;
        stop = buf.length;
    } else {
        validateOffset(offset, "offset");
        start = offset;
        if (end === undefined) {
            stop = buf.length;
        } else {
            validateOffset(end, "end", 0, buf.length);
            stop = end;
        }
        if (start >= stop) return buf;
    }

    if (typeof value === "number") {
        if (start > stop || stop > buf.byteLength) {
            throw ERR_BUFFER_OUT_OF_BOUNDS();
        }
        u8Fill.call(buf, value, start, stop);
        return buf;
    }

    // what src/node_buffer.cc Fill does with the other values
    if (stop > buf.length) throw ERR_BUFFER_OUT_OF_BOUNDS();
    const fillLength = stop - start;
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength
        ).slice();
    } else if (typeof value !== "string") {
        u8Fill.call(buf, (+value >>> 0) & 255, start, stop);
        return buf;
    } else if (normalized === "utf8") {
        bytes = utf8Encode(value);
    } else if (normalized === "utf16le") {
        bytes = ucs2Ops.from(value);
    } else {
        // written in place, at most fillLength bytes
        const written = getEncodingOps(normalized).write(
            buf,
            value,
            start,
            fillLength
        );
        bytes = new Uint8Array(buf.buffer, buf.byteOffset + start, written);
    }

    if (bytes.length >= fillLength) {
        buf.set(bytes.subarray(0, fillLength), start);
        return buf;
    }
    if (bytes.length === 0) throw ERR_INVALID_ARG_VALUE("value", value);
    buf.set(bytes, start);
    // doubles what is filled until the range is
    let filled = bytes.length;
    while (filled < fillLength) {
        const chunk = Math.min(filled, fillLength - filled);
        buf.copyWithin(start + filled, start, start + chunk);
        filled += chunk;
    }
    return buf;
}

// indexOf

// src/node_buffer.cc IndexOfOffset: where a search starts, -1 for none
function indexOfOffset(
    length: number,
    offset: number,
    needleLength: number,
    isForward: boolean
) {
    if (offset < 0) {
        if (offset + length >= 0) return length + offset;
        if (isForward || needleLength === 0) return 0;
        return -1;
    }
    if (offset + needleLength <= length) return offset;
    if (needleLength === 0) return length;
    if (isForward) return -1;
    return length - 1;
}

function indexOfNumber(
    buf: Uint8Array,
    value: number,
    byteOffset: number,
    isForward: boolean
) {
    const offset = indexOfOffset(buf.length, byteOffset, 1, isForward);
    if (offset <= -1 || buf.length === 0) return -1;
    return isForward
        ? u8IndexOf.call(buf, value & 0xff, offset)
        : u8LastIndexOf.call(buf, value & 0xff, offset);
}

// src/node_buffer.cc IndexOfString and IndexOfBuffer. utf16le searches
// whole units, at even offsets. IndexOfString rounds the haystack down to
// an even length, IndexOfBuffer does not: a needle it does not find in an
// odd-length haystack is reported at length - 1, which this reproduces.
function indexOfBytes(
    buf: Uint8Array,
    needle: Uint8Array,
    byteOffset: number,
    ucs2: boolean,
    isForward: boolean,
    stringNeedle: boolean
) {
    const length = ucs2 && stringNeedle ? buf.length & ~1 : buf.length;
    const needleLength = needle.length;
    const offset = indexOfOffset(length, byteOffset, needleLength, isForward);

    if (needleLength === 0) return offset;
    if (length === 0 || offset <= -1) return -1;
    if (
        (isForward && needleLength + offset > length) ||
        needleLength > length
    ) {
        return -1;
    }

    if (ucs2) {
        if (length < 2 || needleLength < 2) return -1;
        const units = searchUnits(
            buf,
            length >>> 1,
            needle,
            needleLength >>> 1,
            offset >>> 1,
            isForward
        );
        const result = (units === -1 ? length >>> 1 : units) * 2;
        return result === length ? -1 : result;
    }
    return searchBytes(buf, length, needle, needleLength, offset, isForward);
}

// first (last) match at or after (before) start; candidates come from the
// engine's indexOf on the first byte
function searchBytes(
    haystack: Uint8Array,
    length: number,
    needle: Uint8Array,
    needleLength: number,
    start: number,
    isForward: boolean
) {
    const last = length - needleLength;
    const first = needle[0];
    if (isForward) {
        for (let i = start; i <= last; i++) {
            i = u8IndexOf.call(haystack, first, i);
            if (i === -1 || i > last) return -1;
            let j = 1;
            while (j < needleLength && haystack[i + j] === needle[j]) j++;
            if (j === needleLength) return i;
        }
        return -1;
    }
    for (let i = Math.min(start, last); i >= 0; i--) {
        i = u8LastIndexOf.call(haystack, first, i);
        if (i === -1) return -1;
        let j = 1;
        while (j < needleLength && haystack[i + j] === needle[j]) j++;
        if (j === needleLength) return i;
    }
    return -1;
}

// the same in 16-bit units, at even byte offsets of the haystack
function searchUnits(
    haystack: Uint8Array,
    units: number,
    needle: Uint8Array,
    needleUnits: number,
    start: number,
    isForward: boolean
) {
    const last = units - needleUnits;
    const bytes = needleUnits * 2;
    const matches = (u: number) => {
        const at = u * 2;
        for (let j = 0; j < bytes; j++) {
            if (haystack[at + j] !== needle[j]) return false;
        }
        return true;
    };
    if (isForward) {
        for (let u = start; u <= last; u++) if (matches(u)) return u;
    } else {
        for (let u = Math.min(start, last); u >= 0; u--) {
            if (matches(u)) return u;
        }
    }
    return -1;
}

function bidirectionalIndexOf(
    buf: Uint8Array,
    value: unknown,
    byteOffset: unknown,
    encoding: unknown,
    isForward: boolean
) {
    if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = undefined;
    } else if ((byteOffset as number) > 0x7fffffff) {
        byteOffset = 0x7fffffff;
    } else if ((byteOffset as number) < -0x80000000) {
        byteOffset = -0x80000000;
    }
    // null and [] become 0, undefined and {} NaN: the whole buffer
    let offset = +byteOffset;
    if (Number.isNaN(offset)) offset = isForward ? 0 : buf.length;
    offset = Math.trunc(offset);

    if (typeof value === "number") {
        return indexOfNumber(buf, value >>> 0, offset, isForward);
    }

    const ops = encoding === undefined ? utf8Ops : getEncodingOps(encoding);

    if (typeof value === "string") {
        if (ops === undefined) throw ERR_UNKNOWN_ENCODING(encoding);
        return indexOfBytes(
            buf,
            ops.needle(value),
            offset,
            ops.ucs2,
            isForward,
            true
        );
    }

    if (isUint8Array(value)) {
        return indexOfBytes(buf, value, offset, !!ops?.ucs2, isForward, false);
    }

    throw ERR_INVALID_ARG_TYPE(
        "value",
        ["number", "string", "Buffer", "Uint8Array"],
        value
    );
}

// The *Slice and *Write methods: Node's C++ bindings, with their checks

// src/util-inl.h ParseArrayIndex
function parseArrayIndex(value: unknown, defaultValue: number) {
    if (value === undefined) return defaultValue;
    const index = Math.trunc(+value) || 0;
    if (index < 0) throw ERR_INDEX_OUT_OF_RANGE();
    return index;
}

function sliceMethod(
    decode: (buf: Uint8Array, start: number, end: number) => string
) {
    return function (this: Uint8Array, start?: number, end?: number) {
        const length = this.length;
        if (length === 0) return "";
        const from = parseArrayIndex(start, 0);
        let to = parseArrayIndex(end, length);
        if (to < from) to = from;
        if (to > length) throw ERR_INDEX_OUT_OF_RANGE();
        return decode(this, from, to);
    };
}

// Node 22+ has utf8Write, asciiWrite and latin1Write in JavaScript, with
// these checks (lib/internal/buffer.js) and an integer conversion after them
function jsWriteMethod(write: EncodingOps["write"]) {
    return function (
        this: Uint8Array,
        string: string,
        offset: any = 0,
        length: any = this.byteLength - offset
    ) {
        if (offset < 0 || offset > this.byteLength) {
            throw ERR_BUFFER_OUT_OF_BOUNDS("offset");
        }
        if (length < 0 || length > this.byteLength - offset) {
            throw ERR_BUFFER_OUT_OF_BOUNDS("length");
        }
        if (typeof string !== "string") {
            throw ERR_INVALID_ARG_TYPE("argument", "string", string);
        }
        const start = Math.trunc(+offset) || 0;
        const max = Math.min(Math.trunc(+length) || 0, this.byteLength - start);
        return max > 0 ? write(this, string, start, max) : 0;
    };
}

// the others are still C++ (src/node_buffer.cc StringWrite)
function writeMethod(write: EncodingOps["write"]) {
    return function (
        this: Uint8Array,
        string: string,
        offset?: number,
        length?: number
    ) {
        if (typeof string !== "string") {
            throw ERR_INVALID_ARG_TYPE("argument", "string", string);
        }
        const size = this.length;
        const start = parseArrayIndex(offset, 0);
        if (start > size) throw ERR_BUFFER_OUT_OF_BOUNDS("offset");
        const max = Math.min(
            size - start,
            parseArrayIndex(length, size - start)
        );
        if (max === 0) return 0;
        return write(this, string, start, max);
    };
}

// The Buffer function

function Buffer(
    arg: unknown,
    encodingOrOffset?: unknown,
    length?: unknown
): FastBuffer {
    if (typeof arg === "number") {
        if (typeof encodingOrOffset === "string") {
            throw ERR_INVALID_ARG_TYPE("string", "string", arg);
        }
        return alloc(arg);
    }
    return from(arg, encodingOrOffset, length);
}

Buffer.prototype = FastBuffer.prototype;
FastBuffer.prototype.constructor = Buffer;
Object.setPrototypeOf(Buffer, Uint8Array);
// map(), filter() and co make FastBuffers
Object.defineProperty(Buffer, Symbol.species, {
    enumerable: false,
    configurable: true,
    get() {
        return FastBuffer;
    }
});

Buffer.poolSize = 8 * 1024;
Buffer.from = from;
Buffer.copyBytesFrom = copyBytesFrom;
// %TypedArray%.of without the Buffer() constructor, an arrow function so
// that it is not a constructor itself (as in Node)
const of = (...items: number[]) => {
    const buf = new FastBuffer(items.length);
    for (let k = 0; k < items.length; k++) buf[k] = items[k];
    return buf;
};
Buffer.of = of;
Buffer.alloc = alloc;
Buffer.allocUnsafe = allocUnsafe;
Buffer.allocUnsafeSlow = function allocUnsafeSlow(size: number) {
    validateNumber(size, "size", 0, kMaxLength);
    return new FastBuffer(size);
};
Buffer.isBuffer = function isBuffer(b: unknown): boolean {
    return b instanceof Buffer;
};
Buffer.compare = compare;
Buffer.isEncoding = function isEncoding(encoding: unknown): boolean {
    return (
        typeof encoding === "string" &&
        encoding.length !== 0 &&
        normalizeEncoding(encoding) !== undefined
    );
};
Buffer.concat = concat;
Buffer.byteLength = byteLength;

// Prototype

const proto = FastBuffer.prototype as FastBuffer & Record<string, unknown>;

// Read and write numbers, with the results and errors of Node's
// lib/internal/buffer.js. The readers up to 32 bits are written for the
// JIT: an in-bounds integer offset reads with integer operations, anything
// else (the default offset included) goes to readSlow. Their bytecode stays
// small enough for JavaScriptCore to inline them where it does not inline
// the caller (a shared loop, a callback), which a throw in the body
// prevents. The other lengths share one function per direction, with
// Node's arithmetic.

type Read = (this: Uint8Array, offset?: number) => number;

function checkOffsetType(offset: unknown) {
    if (typeof offset !== "number") {
        throw ERR_INVALID_ARG_TYPE("offset", "number", offset);
    }
}

function readSlow(
    buf: Uint8Array,
    offset: unknown,
    byteLength: number,
    read: Read
): number {
    if (offset === undefined) return read.call(buf, 0);
    checkOffsetType(offset);
    // a number that is not an index of byteLength bytes in buf
    boundsError(offset as number, buf.length - byteLength);
}

function boundsError(value: number, length: number, type?: string): never {
    if (Math.floor(value) !== value) {
        if (type) validateNumber(value, type);
        throw ERR_OUT_OF_RANGE(type || "offset", "an integer", value);
    }
    if (length < 0) throw ERR_BUFFER_OUT_OF_BOUNDS();
    throw ERR_OUT_OF_RANGE(
        type || "offset",
        `>= ${type ? 1 : 0} and <= ${length}`,
        value
    );
}

// offset and offset + byteLength are in buf
function checkBounds(buf: Uint8Array, offset: number, byteLength: number) {
    checkOffsetType(offset);
    if (buf[offset] === undefined || buf[offset + byteLength] === undefined) {
        boundsError(offset, buf.length - (byteLength + 1));
    }
}

function checkInt(
    value: number | bigint,
    min: number | bigint,
    max: number | bigint,
    buf: Uint8Array,
    offset: number,
    byteLength: number
) {
    if (value > max || value < min) {
        const n = typeof min === "bigint" ? "n" : "";
        let range: string;
        if (byteLength > 3) {
            if (min === 0 || min === 0n) {
                range = `>= 0${n} and < 2${n} ** ${(byteLength + 1) * 8}${n}`;
            } else {
                range =
                    `>= -(2${n} ** ${(byteLength + 1) * 8 - 1}${n}) and ` +
                    `< 2 ** ${(byteLength + 1) * 8 - 1}${n}`;
            }
        } else {
            range = `>= ${min}${n} and <= ${max}${n}`;
        }
        throw ERR_OUT_OF_RANGE("value", range, value);
    }
    checkBounds(buf, offset, byteLength);
}

function readUInt8(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 1 > this.length) {
        return readSlow(this, offset, 1, readUInt8);
    }
    return this[o];
}

function readInt8(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 1 > this.length) {
        return readSlow(this, offset, 1, readInt8);
    }
    return (this[o] << 24) >> 24;
}

function readUInt16LE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 2 > this.length) {
        return readSlow(this, offset, 2, readUInt16LE);
    }
    return this[o] | (this[o + 1] << 8);
}

function readUInt16BE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 2 > this.length) {
        return readSlow(this, offset, 2, readUInt16BE);
    }
    return (this[o] << 8) | this[o + 1];
}

function readInt16LE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 2 > this.length) {
        return readSlow(this, offset, 2, readInt16LE);
    }
    return ((this[o] | (this[o + 1] << 8)) << 16) >> 16;
}

function readInt16BE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 2 > this.length) {
        return readSlow(this, offset, 2, readInt16BE);
    }
    return (((this[o] << 8) | this[o + 1]) << 16) >> 16;
}

function readUInt32LE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 4 > this.length) {
        return readSlow(this, offset, 4, readUInt32LE);
    }
    return (
        (this[o] |
            (this[o + 1] << 8) |
            (this[o + 2] << 16) |
            (this[o + 3] << 24)) >>>
        0
    );
}

function readUInt32BE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 4 > this.length) {
        return readSlow(this, offset, 4, readUInt32BE);
    }
    return (
        ((this[o] << 24) |
            (this[o + 1] << 16) |
            (this[o + 2] << 8) |
            this[o + 3]) >>>
        0
    );
}

function readInt32LE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 4 > this.length) {
        return readSlow(this, offset, 4, readInt32LE);
    }
    return (
        this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24)
    );
}

function readInt32BE(this: Uint8Array, offset?: number): number {
    const o = offset >>> 0;
    if (o !== offset || o + 4 > this.length) {
        return readSlow(this, offset, 4, readInt32BE);
    }
    return (
        (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]
    );
}

// readUIntLE and co: 3, 5 and 6 bytes here, the others by their method
function readN(
    buf: Uint8Array,
    offset: number,
    byteLength: number,
    littleEndian: boolean,
    signed: boolean
) {
    checkOffsetType(offset);
    const first = buf[offset];
    const last = buf[offset + byteLength - 1];
    if (first === undefined || last === undefined) {
        boundsError(offset, buf.length - byteLength);
    }
    let value = 0;
    for (let i = 0; i < byteLength; i++) {
        value =
            value * 256 + buf[offset + (littleEndian ? byteLength - 1 - i : i)];
    }
    return signed && value >= 2 ** (8 * byteLength - 1)
        ? value - 2 ** (8 * byteLength)
        : value;
}

function readVariable(
    littleEndian: boolean,
    signed: boolean,
    reads: Record<number, Read>
) {
    return function (this: Uint8Array, offset: number, byteLength: number) {
        if (offset === undefined) {
            throw ERR_INVALID_ARG_TYPE("offset", "number", offset);
        }
        if (byteLength === 6 || byteLength === 5 || byteLength === 3) {
            return readN(this, offset, byteLength, littleEndian, signed);
        }
        if (byteLength === 4 || byteLength === 2 || byteLength === 1) {
            return reads[byteLength].call(this, offset);
        }
        boundsError(byteLength, 6, "byteLength");
    };
}

function readBig64(
    buf: Uint8Array,
    offset: number,
    littleEndian: boolean,
    signed: boolean
) {
    checkOffsetType(offset);
    const first = buf[offset];
    const last = buf[offset + 7];
    if (first === undefined || last === undefined) {
        boundsError(offset, buf.length - 8);
    }
    const lo = littleEndian
        ? readUInt32LE.call(buf, offset)
        : readUInt32BE.call(buf, offset + 4);
    const hi = littleEndian
        ? readUInt32LE.call(buf, offset + 4)
        : readUInt32BE.call(buf, offset);
    const value = (BigInt(hi) << 32n) + BigInt(lo);
    return signed ? BigInt.asIntN(64, value) : value;
}

// floats go through the bytes of a scratch Float32Array/Float64Array, in
// the platform's order
const float32Array = new Float32Array(1);
const uInt8Float32Array = new Uint8Array(float32Array.buffer);
const float64Array = new Float64Array(1);
const uInt8Float64Array = new Uint8Array(float64Array.buffer);

function readFloat(buf: Uint8Array, offset: number, littleEndian: boolean) {
    checkOffsetType(offset);
    const first = buf[offset];
    const last = buf[offset + 3];
    if (first === undefined || last === undefined) {
        boundsError(offset, buf.length - 4);
    }
    const forward = littleEndian === LITTLE_ENDIAN;
    for (let i = 0; i < 4; i++) {
        uInt8Float32Array[forward ? i : 3 - i] = buf[offset + i];
    }
    return float32Array[0];
}

function readDouble(buf: Uint8Array, offset: number, littleEndian: boolean) {
    checkOffsetType(offset);
    const first = buf[offset];
    const last = buf[offset + 7];
    if (first === undefined || last === undefined) {
        boundsError(offset, buf.length - 8);
    }
    const forward = littleEndian === LITTLE_ENDIAN;
    for (let i = 0; i < 8; i++) {
        uInt8Float64Array[forward ? i : 7 - i] = buf[offset + i];
    }
    return float64Array[0];
}

function writeFloat(
    buf: Uint8Array,
    value: unknown,
    offset: number,
    littleEndian: boolean
) {
    float32Array[0] = +value;
    checkBounds(buf, offset, 3);
    const forward = littleEndian === LITTLE_ENDIAN;
    for (let i = 0; i < 4; i++) {
        buf[offset + i] = uInt8Float32Array[forward ? i : 3 - i];
    }
    return offset + 4;
}

function writeDouble(
    buf: Uint8Array,
    value: unknown,
    offset: number,
    littleEndian: boolean
) {
    float64Array[0] = +value;
    checkBounds(buf, offset, 7);
    const forward = littleEndian === LITTLE_ENDIAN;
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = uInt8Float64Array[forward ? i : 7 - i];
    }
    return offset + 8;
}

function writeBig64(
    buf: Uint8Array,
    value: bigint,
    offset: number,
    littleEndian: boolean,
    signed: boolean
) {
    if (signed) {
        checkInt(value, -(2n ** 63n), 2n ** 63n - 1n, buf, offset, 7);
    } else {
        checkInt(value, 0n, 2n ** 64n - 1n, buf, offset, 7);
    }
    const lo = Number(value & 0xffffffffn);
    const hi = Number((value >> 32n) & 0xffffffffn);
    for (let i = 0; i < 4; i++) {
        buf[littleEndian ? offset + i : offset + 7 - i] = lo >>> (8 * i);
        buf[littleEndian ? offset + 4 + i : offset + 3 - i] = hi >>> (8 * i);
    }
    return offset + 8;
}

// every integer writer: Node's arithmetic for each length, the low 32 bits
// with >>>, the bits above with Math.floor (the same bytes for negative and
// fractional values)
function writeN(
    buf: Uint8Array,
    value: unknown,
    offset: number,
    byteLength: number,
    littleEndian: boolean,
    min: number,
    max: number
) {
    const v = +value;
    if (byteLength === 1) {
        // checkInt reads two entries, one is enough here
        checkOffsetType(offset);
        if (v > max || v < min) {
            throw ERR_OUT_OF_RANGE("value", `>= ${min} and <= ${max}`, v);
        }
        if (buf[offset] === undefined) boundsError(offset, buf.length - 1);
        buf[offset] = v;
        return offset + 1;
    }
    checkInt(v, min, max, buf, offset, byteLength - 1);
    const last = offset + byteLength - 1;
    for (let i = 0; i < 4 && i < byteLength; i++) {
        buf[littleEndian ? offset + i : last - i] = v >>> (8 * i);
    }
    if (byteLength > 4) {
        const hi = Math.floor(v * 2 ** -32);
        buf[littleEndian ? offset + 4 : last - 4] = hi;
        if (byteLength > 5) buf[littleEndian ? offset + 5 : offset] = hi >>> 8;
    }
    return offset + byteLength;
}

function intRange(byteLength: number, signed: boolean): [number, number] {
    const bits = 8 * byteLength;
    return signed
        ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1]
        : [0, 2 ** bits - 1];
}

// writeUInt32LE and co
function writeFixed(
    byteLength: number,
    littleEndian: boolean,
    signed: boolean
) {
    const [min, max] = intRange(byteLength, signed);
    return function (this: Uint8Array, value: number, offset = 0) {
        return writeN(this, value, offset, byteLength, littleEndian, min, max);
    };
}

// writeUIntLE and co
function writeVariable(littleEndian: boolean, signed: boolean) {
    return function (
        this: Uint8Array,
        value: number,
        offset: number,
        byteLength: number
    ) {
        if (byteLength >= 1 && byteLength <= 6 && byteLength % 1 === 0) {
            const [min, max] = intRange(byteLength, signed);
            return writeN(
                this,
                value,
                offset,
                byteLength,
                littleEndian,
                min,
                max
            );
        }
        boundsError(byteLength, 6, "byteLength");
    };
}

const numberMethods = {
    readBigUInt64LE(this: Uint8Array, offset = 0) {
        return readBig64(this, offset, true, false);
    },
    readBigUInt64BE(this: Uint8Array, offset = 0) {
        return readBig64(this, offset, false, false);
    },
    readBigInt64LE(this: Uint8Array, offset = 0) {
        return readBig64(this, offset, true, true);
    },
    readBigInt64BE(this: Uint8Array, offset = 0) {
        return readBig64(this, offset, false, true);
    },
    writeBigUInt64LE(this: Uint8Array, value: bigint, offset = 0) {
        return writeBig64(this, value, offset, true, false);
    },
    writeBigUInt64BE(this: Uint8Array, value: bigint, offset = 0) {
        return writeBig64(this, value, offset, false, false);
    },
    writeBigInt64LE(this: Uint8Array, value: bigint, offset = 0) {
        return writeBig64(this, value, offset, true, true);
    },
    writeBigInt64BE(this: Uint8Array, value: bigint, offset = 0) {
        return writeBig64(this, value, offset, false, true);
    },

    readUIntLE: readVariable(true, false, {
        1: readUInt8,
        2: readUInt16LE,
        4: readUInt32LE
    }),
    readUInt32LE,
    readUInt16LE,
    readUInt8,
    readUIntBE: readVariable(false, false, {
        1: readUInt8,
        2: readUInt16BE,
        4: readUInt32BE
    }),
    readUInt32BE,
    readUInt16BE,
    readIntLE: readVariable(true, true, {
        1: readInt8,
        2: readInt16LE,
        4: readInt32LE
    }),
    readInt32LE,
    readInt16LE,
    readInt8,
    readIntBE: readVariable(false, true, {
        1: readInt8,
        2: readInt16BE,
        4: readInt32BE
    }),
    readInt32BE,
    readInt16BE,

    writeUIntLE: writeVariable(true, false),
    writeUInt32LE: writeFixed(4, true, false),
    writeUInt16LE: writeFixed(2, true, false),
    writeUInt8: writeFixed(1, true, false),
    writeUIntBE: writeVariable(false, false),
    writeUInt32BE: writeFixed(4, false, false),
    writeUInt16BE: writeFixed(2, false, false),
    writeIntLE: writeVariable(true, true),
    writeInt32LE: writeFixed(4, true, true),
    writeInt16LE: writeFixed(2, true, true),
    writeInt8: writeFixed(1, true, true),
    writeIntBE: writeVariable(false, true),
    writeInt32BE: writeFixed(4, false, true),
    writeInt16BE: writeFixed(2, false, true),

    readFloatLE(this: Uint8Array, offset = 0) {
        return readFloat(this, offset, true);
    },
    readFloatBE(this: Uint8Array, offset = 0) {
        return readFloat(this, offset, false);
    },
    readDoubleLE(this: Uint8Array, offset = 0) {
        return readDouble(this, offset, true);
    },
    readDoubleBE(this: Uint8Array, offset = 0) {
        return readDouble(this, offset, false);
    },
    writeFloatLE(this: Uint8Array, value: number, offset = 0) {
        return writeFloat(this, value, offset, true);
    },
    writeFloatBE(this: Uint8Array, value: number, offset = 0) {
        return writeFloat(this, value, offset, false);
    },
    writeDoubleLE(this: Uint8Array, value: number, offset = 0) {
        return writeDouble(this, value, offset, true);
    },
    writeDoubleBE(this: Uint8Array, value: number, offset = 0) {
        return writeDouble(this, value, offset, false);
    }
};

Object.assign(proto, numberMethods);
// the lowercase aliases
for (const name of Object.keys(numberMethods)) {
    if (name.includes("UInt")) {
        proto[name.replace("UInt", "Uint")] =
            numberMethods[name as keyof typeof numberMethods];
    }
}

Object.assign(proto, {
    asciiSlice: sliceMethod(asciiSlice),
    base64Slice: sliceMethod(base64Ops.slice),
    base64urlSlice: sliceMethod(base64urlOps.slice),
    latin1Slice: sliceMethod(latin1Slice),
    hexSlice: sliceMethod(hexSlice),
    ucs2Slice: sliceMethod(ucs2Slice),
    utf8Slice: sliceMethod(utf8Slice),
    asciiWrite: jsWriteMethod(latin1Write),
    base64Write: writeMethod(base64Write),
    base64urlWrite: writeMethod(base64Write),
    latin1Write: jsWriteMethod(latin1Write),
    hexWrite: writeMethod(hexWrite),
    ucs2Write: writeMethod(ucs2Write),
    utf8Write: jsWriteMethod(utf8Write)
});

// the deprecated buf.parent and buf.offset
Object.defineProperty(proto, "parent", {
    enumerable: true,
    configurable: true,
    get(this: unknown) {
        if (!(this instanceof Buffer)) return undefined;
        return this.buffer;
    }
});
Object.defineProperty(proto, "offset", {
    enumerable: true,
    configurable: true,
    get(this: unknown) {
        if (!(this instanceof Buffer)) return undefined;
        return this.byteOffset;
    }
});

function toString(
    this: Uint8Array,
    encoding?: unknown,
    start?: number,
    end?: number
): string {
    if (arguments.length === 0) return utf8Slice(this, 0, this.length);

    const length = this.length;
    if (start <= 0) start = 0;
    else if (start >= length) return "";
    else start = Math.trunc(start) || 0;

    if (end === undefined || end > length) end = length;
    else end = Math.trunc(end) || 0;

    if (end <= start) return "";
    if (encoding === undefined) return utf8Slice(this, start, end);

    const ops = getEncodingOps(encoding);
    if (ops === undefined) throw ERR_UNKNOWN_ENCODING(encoding);
    return ops.slice(this, start, end);
}

function adjustOffset(offset: number, length: number) {
    // Math.trunc, not | 0: offsets can be above 2 ** 31
    offset = Math.trunc(offset);
    if (offset === 0 || Number.isNaN(offset)) return 0;
    if (offset < 0) {
        offset += length;
        return offset > 0 ? offset : 0;
    }
    return offset < length ? offset : length;
}

function subarray(this: Uint8Array, start?: number, end?: number) {
    const length = this.length;
    start = adjustOffset(start, length);
    end = end !== undefined ? adjustOffset(end, length) : length;
    return new FastBuffer(
        this.buffer as ArrayBuffer,
        this.byteOffset + start,
        end > start ? end - start : 0
    );
}

function swap(buf: Uint8Array, a: number, b: number) {
    const i = buf[a];
    buf[a] = buf[b];
    buf[b] = i;
}

// lib/buffer.js: the bytes as hex pairs, then the own non-index properties
function inspect(
    this: Uint8Array,
    _recurseTimes?: number,
    ctx?: { showHidden?: boolean },
    inspectFn?: (value: unknown, options?: object) => string
) {
    const max = INSPECT_MAX_BYTES;
    const actualMax = Math.min(max, this.length);
    const remaining = this.length - max;
    let str = hexSlice(this, 0, actualMax)
        .replace(/(.{2})/g, "$1 ")
        .trim();
    if (remaining > 0) {
        str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
    }
    // listing the keys of a typed array lists every index: buffers above a
    // few KB are shown without their extra properties
    if (ctx && this.length <= INSPECT_EXTRAS_MAX_LENGTH) {
        const keys: PropertyKey[] = (
            ctx.showHidden
                ? Object.getOwnPropertyNames(this)
                : Object.keys(this)
        ).filter((key) => !isIndex(key));
        for (const symbol of Object.getOwnPropertySymbols(this)) {
            if (
                ctx.showHidden ||
                Object.prototype.propertyIsEnumerable.call(this, symbol)
            ) {
                keys.push(symbol);
            }
        }
        if (keys.length > 0) {
            const obj = Object.create(null);
            for (const key of keys) obj[key] = (this as any)[key];
            if (this.length !== 0) str += ", ";
            str +=
                typeof inspectFn === "function"
                    ? inspectFn(obj, {
                          ...ctx,
                          breakLength: Infinity,
                          compact: true
                      }).slice(27, -2)
                    : keys
                          .map((key) => `${String(key)}: ${String(obj[key])}`)
                          .join(", ");
        }
    }
    let constructorName = "Buffer";
    try {
        const { constructor } = this;
        if (
            typeof constructor === "function" &&
            Object.prototype.hasOwnProperty.call(constructor, "name")
        ) {
            constructorName = constructor.name;
        }
    } catch {}
    return `<${constructorName} ${str}>`;
}

const INSPECT_EXTRAS_MAX_LENGTH = 4096;

function isIndex(key: string) {
    const n = +key;
    return Number.isInteger(n) && n >= 0 && String(n) === key;
}

Object.assign(proto, {
    copy(
        this: Uint8Array,
        target: Uint8Array,
        targetStart?: number,
        sourceStart?: number,
        sourceEnd?: number
    ) {
        return copy(this, target, targetStart, sourceStart, sourceEnd);
    },

    toString,

    equals(this: Uint8Array, otherBuffer: Uint8Array) {
        if (!isUint8Array(otherBuffer)) {
            throw ERR_INVALID_ARG_TYPE(
                "otherBuffer",
                ["Buffer", "Uint8Array"],
                otherBuffer
            );
        }
        if (this === otherBuffer) return true;
        const length = this.byteLength;
        if (length !== otherBuffer.byteLength) return false;
        return (
            length === 0 ||
            compareBytes(this, 0, length, otherBuffer, 0, length) === 0
        );
    },

    inspect,

    compare(
        this: Uint8Array,
        target: Uint8Array,
        targetStart?: number,
        targetEnd?: number,
        sourceStart?: number,
        sourceEnd?: number
    ) {
        if (!isUint8Array(target)) {
            throw ERR_INVALID_ARG_TYPE(
                "target",
                ["Buffer", "Uint8Array"],
                target
            );
        }
        if (arguments.length === 1) {
            return compareBytes(this, 0, this.length, target, 0, target.length);
        }

        if (targetStart === undefined) targetStart = 0;
        else validateOffset(targetStart, "targetStart");
        if (targetEnd === undefined) targetEnd = target.length;
        else validateOffset(targetEnd, "targetEnd", 0, target.length);
        if (sourceStart === undefined) sourceStart = 0;
        else validateOffset(sourceStart, "sourceStart");
        if (sourceEnd === undefined) sourceEnd = this.length;
        else validateOffset(sourceEnd, "sourceEnd", 0, this.length);

        if (sourceStart >= sourceEnd) {
            return targetStart >= targetEnd ? 0 : -1;
        }
        if (targetStart >= targetEnd) return 1;

        // src/node_buffer.cc CompareOffset
        const length = Math.min(
            sourceEnd - sourceStart,
            targetEnd - targetStart,
            this.length - sourceStart
        );
        const result = compareBytes(
            this,
            sourceStart,
            sourceStart + length,
            target,
            targetStart,
            targetStart + length
        );
        if (result !== 0) return result;
        const a = sourceEnd - sourceStart;
        const b = targetEnd - targetStart;
        return a > b ? 1 : a < b ? -1 : 0;
    },

    indexOf(
        this: Uint8Array,
        value: unknown,
        byteOffset?: unknown,
        encoding?: unknown
    ) {
        return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
    },

    lastIndexOf(
        this: Uint8Array,
        value: unknown,
        byteOffset?: unknown,
        encoding?: unknown
    ) {
        return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
    },

    includes(
        this: Uint8Array,
        value: unknown,
        byteOffset?: unknown,
        encoding?: unknown
    ) {
        return (
            bidirectionalIndexOf(this, value, byteOffset, encoding, true) !== -1
        );
    },

    fill(
        this: FastBuffer,
        value: unknown,
        offset?: unknown,
        end?: unknown,
        encoding?: unknown
    ) {
        return fillBuffer(this, value, offset, end, encoding);
    },

    write(
        this: Uint8Array,
        string: string,
        offset?: unknown,
        length?: unknown,
        encoding?: unknown
    ) {
        // write(string)
        if (offset === undefined) {
            if (typeof string !== "string") {
                throw ERR_INVALID_ARG_TYPE("argument", "string", string);
            }
            return utf8Write(this, string, 0, this.length);
        }
        // write(string, encoding)
        if (length === undefined && typeof offset === "string") {
            encoding = offset;
            length = this.length;
            offset = 0;
        } else {
            // write(string, offset[, length][, encoding])
            validateOffset(offset, "offset", 0, this.length);
            const remaining = this.length - offset;
            if (length === undefined) {
                length = remaining;
            } else if (typeof length === "string") {
                encoding = length;
                length = remaining;
            } else {
                validateOffset(length, "length", 0, this.length);
                if (length > remaining) length = remaining;
            }
        }

        let ops: EncodingOps;
        if (!encoding || encoding === "utf8") ops = utf8Ops;
        else if (encoding === "ascii") ops = asciiOps;
        else {
            ops = getEncodingOps(encoding);
            if (ops === undefined) throw ERR_UNKNOWN_ENCODING(encoding);
        }
        if (typeof string !== "string") {
            throw ERR_INVALID_ARG_TYPE("argument", "string", string);
        }
        return ops.write(this, string, offset as number, length as number);
    },

    toJSON(this: Uint8Array) {
        const data = new Array<number>(this.length);
        for (let i = 0; i < this.length; ++i) data[i] = this[i];
        return { type: "Buffer", data };
    },

    subarray,

    // a view too, unlike Uint8Array#slice
    slice: subarray,

    swap16(this: Uint8Array) {
        const length = this.length;
        if (length % 2 !== 0) throw ERR_INVALID_BUFFER_SIZE("16-bits");
        for (let i = 0; i < length; i += 2) swap(this, i, i + 1);
        return this;
    },

    swap32(this: Uint8Array) {
        const length = this.length;
        if (length % 4 !== 0) throw ERR_INVALID_BUFFER_SIZE("32-bits");
        for (let i = 0; i < length; i += 4) {
            swap(this, i, i + 3);
            swap(this, i + 1, i + 2);
        }
        return this;
    },

    swap64(this: Uint8Array) {
        const length = this.length;
        if (length % 8 !== 0) throw ERR_INVALID_BUFFER_SIZE("64-bits");
        for (let i = 0; i < length; i += 8) {
            swap(this, i, i + 7);
            swap(this, i + 1, i + 6);
            swap(this, i + 2, i + 5);
            swap(this, i + 3, i + 4);
        }
        return this;
    },

    toLocaleString: toString
});

Object.defineProperty(proto, customInspectSymbol, {
    value: inspect,
    writable: true,
    enumerable: false,
    configurable: true
});

// Module functions

function SlowBuffer(size: number) {
    validateNumber(size, "size", 0, kMaxLength);
    return new FastBuffer(size);
}
Object.setPrototypeOf(SlowBuffer.prototype, Uint8Array.prototype);
Object.setPrototypeOf(SlowBuffer, Uint8Array);

function bytesOf(input: ArrayBufferView | ArrayBufferLike) {
    return ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
}

function validateBinaryInput(input: unknown) {
    if (!isTypedArray(input) && !isAnyArrayBuffer(input)) {
        throw ERR_INVALID_ARG_TYPE(
            "input",
            ["ArrayBuffer", "Buffer", "TypedArray"],
            input
        );
    }
    return bytesOf(input);
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isUtf8(input: ArrayBufferView | ArrayBufferLike): boolean {
    const bytes = validateBinaryInput(input);
    if (isAsciiRange(bytes, 0, bytes.length)) return true;
    try {
        fatalUtf8Decoder.decode(
            bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice()
        );
        return true;
    } catch {
        return false;
    }
}

export function isAscii(input: ArrayBufferView | ArrayBufferLike): boolean {
    const bytes = validateBinaryInput(input);
    return isAsciiRange(bytes, 0, bytes.length);
}

// src/node_i18n.cc Transcode: ICU between ascii, latin1, ucs2 and utf8.
// Unmappable characters become "?"; invalid input to or from utf16 fails
// with U_INVALID_CHAR_FOUND where ICU's strict UTF conversions do.
export function transcode(
    source: Uint8Array,
    fromEncoding: string,
    toEncoding: string
) {
    if (!isUint8Array(source)) {
        throw ERR_INVALID_ARG_TYPE("source", ["Buffer", "Uint8Array"], source);
    }
    if (source.length === 0) return new FastBuffer();

    const from = normalizeEncoding(fromEncoding) ?? fromEncoding;
    const to = normalizeEncoding(toEncoding) ?? toEncoding;
    const supported = ["ascii", "latin1", "utf16le", "utf8"];
    if (!supported.includes(from) || !supported.includes(to)) {
        throw transcodeError("U_ILLEGAL_ARGUMENT_ERROR", 1);
    }

    let string: string;
    if (from === "utf8") {
        if (to === "utf16le" && !isUtf8(source)) {
            throw transcodeError("U_INVALID_CHAR_FOUND", 10);
        }
        string = utf8Slice(source, 0, source.length);
    } else if (from === "utf16le" && to === "utf16le") {
        // ICU: U+FFFD for lone surrogates and a trailing half unit
        string = utf16Decoder.decode(source);
    } else if (from === "utf16le") {
        string = ucs2Slice(source, 0, source.length);
        // as Node, a lone byte is an invalid character too
        if (to === "utf8" && (string === "" || hasLoneSurrogate(string))) {
            throw transcodeError("U_INVALID_CHAR_FOUND", 10);
        }
    } else if (from === "ascii" && to !== "utf16le") {
        // ICU's us-ascii reads the high bytes as U+FFFD
        string = latin1Slice(source, 0, source.length).replace(
            /[\x80-\xff]/g,
            "\ufffd"
        );
    } else {
        string = latin1Slice(source, 0, source.length);
    }

    if (to === "utf8") return wrap(utf8Encode(string));
    if (to === "utf16le") return ucs2Ops.from(string);
    // one "?" per code point outside the target, but for the default
    // ignorable ones, which ICU's substitution drops
    const limit = to === "ascii" ? 0x7f : 0xff;
    const codes: number[] = [];
    for (const char of string) {
        const code = char.codePointAt(0);
        if (code <= limit) codes.push(code);
        else if (!DEFAULT_IGNORABLE.test(char)) codes.push(0x3f);
    }
    return fromArrayLike(codes);
}

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const utf16Decoder = new TextDecoder("utf-16le", { ignoreBOM: true });

function hasLoneSurrogate(string: string) {
    for (let i = 0; i < string.length; i++) {
        const c = string.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = string.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) i++;
            else return true;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            return true;
        }
    }
    return false;
}

// Node's own atob and btoa are the WHATWG ones, like the engine's; called
// as methods of this module, the engine's would throw an illegal invocation
export function atob(input: string): string {
    if (arguments.length === 0) throw ERR_MISSING_ARGS("input");
    return globalThis.atob(`${input}`);
}

export function btoa(input: string): string {
    if (arguments.length === 0) throw ERR_MISSING_ARGS("input");
    return globalThis.btoa(`${input}`);
}

export const Blob = globalThis.Blob;
export const File = globalThis.File;

// Node resolves the blob: URLs its own URL.createObjectURL makes; a page's
// blob URLs cannot be resolved to their Blob synchronously
export function resolveObjectURL(_url: string): Blob | undefined {
    return undefined;
}

// typed as Node's for the modules that import it
const NodeBuffer = Buffer as unknown as BufferConstructor;
export { NodeBuffer as Buffer, SlowBuffer };

// what require("buffer") returns
const buffer = {
    Buffer: NodeBuffer,
    SlowBuffer,
    transcode,
    isUtf8,
    isAscii,
    kMaxLength,
    kStringMaxLength,
    btoa,
    atob,
    constants,
    get INSPECT_MAX_BYTES() {
        return INSPECT_MAX_BYTES;
    },
    set INSPECT_MAX_BYTES(value: number) {
        validateNumber(value, "INSPECT_MAX_BYTES", 0);
        INSPECT_MAX_BYTES = value;
    },
    Blob,
    resolveObjectURL,
    File
};

export default buffer;
export { buffer as "module.exports" };

if (!globalThis.Buffer) {
    globalThis.Buffer = NodeBuffer;
}
