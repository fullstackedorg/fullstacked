// The Buffer encodings on plain Uint8Arrays, with Node's semantics (src/
// string_bytes.cc, nbytes): decoders take a [start, end) range, writers write
// at most `max` bytes at `offset` and return the count, like the C++ side.
//
// Hot paths go to the engine when it has the primitive: TextEncoder and
// TextDecoder for utf8, Uint8Array.fromBase64/toBase64/fromHex/toHex (Safari
// 18.2, Chrome 140, Firefox 133) for base64 and hex. Without them, the
// encoders fill a byte array and decode it with TextDecoder (one flat string,
// no `+=`, which builds ropes JavaScriptCore is slow to slice), the decoders
// are table driven loops over charCodeAt.

type NativeBase64Options = {
    alphabet?: "base64" | "base64url";
    omitPadding?: boolean;
};
type NativeUint8ArrayConstructor = {
    fromBase64?: (
        string: string,
        options?: NativeBase64Options
    ) => Uint8Array<ArrayBuffer>;
    fromHex?: (string: string) => Uint8Array<ArrayBuffer>;
};
type NativeUint8Array = Uint8Array & {
    toBase64?: (options?: NativeBase64Options) => string;
    toHex?: () => string;
};

const NativeUint8Array = Uint8Array as unknown as NativeUint8ArrayConstructor;
const hasFromBase64 = typeof NativeUint8Array.fromBase64 === "function";
const hasFromHex = typeof NativeUint8Array.fromHex === "function";
const hasToBase64 =
    typeof (Uint8Array.prototype as NativeUint8Array).toBase64 === "function";
const hasToHex =
    typeof (Uint8Array.prototype as NativeUint8Array).toHex === "function";

export const LITTLE_ENDIAN =
    new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// Node keeps a leading BOM in toString("utf8")
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Encoder = new TextEncoder();

// below this length, a loop beats the call into TextDecoder
const SHORT = 16;
// String.fromCharCode.apply takes its arguments on the stack
const CHAR_CODES_CHUNK = 0x2000;

// a Uint8Array over [start, end) of buf, buf itself when it is the whole
function view(buf: Uint8Array, start: number, end: number): Uint8Array {
    return start === 0 && end === buf.length
        ? buf
        : new Uint8Array(buf.buffer, buf.byteOffset + start, end - start);
}

// TextDecoder refuses views of a SharedArrayBuffer
function decode(bytes: Uint8Array | Uint16Array): string {
    if (bytes.buffer instanceof ArrayBuffer) return utf8Decoder.decode(bytes);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return utf8Decoder.decode(copy);
}

function fromCharCodes(
    codes: Uint8Array | Uint16Array,
    start: number,
    end: number
): string {
    if (end - start <= CHAR_CODES_CHUNK) {
        return String.fromCharCode.apply(
            null,
            codes.subarray(start, end) as unknown as number[]
        );
    }
    const parts: string[] = [];
    for (let i = start; i < end; i += CHAR_CODES_CHUNK) {
        parts.push(
            String.fromCharCode.apply(
                null,
                codes.subarray(
                    i,
                    Math.min(i + CHAR_CODES_CHUNK, end)
                ) as unknown as number[]
            )
        );
    }
    return parts.join("");
}

export function isAsciiRange(buf: Uint8Array, start: number, end: number) {
    for (let i = start; i < end; i++) {
        if (buf[i] > 0x7f) return false;
    }
    return true;
}

// utf8

export function utf8Slice(buf: Uint8Array, start: number, end: number) {
    if (end - start < SHORT) {
        let out = "";
        for (let i = start; i < end; i++) {
            const c = buf[i];
            if (c > 0x7f) return decode(view(buf, start, end));
            out += String.fromCharCode(c);
        }
        return out;
    }
    return decode(view(buf, start, end));
}

export function utf8Encode(string: string): Uint8Array {
    return utf8Encoder.encode(string);
}

// never writes part of a character, like V8's WriteUtf8
export function utf8Write(
    buf: Uint8Array,
    string: string,
    offset: number,
    max: number
) {
    if (max === 0 || string.length === 0) return 0;
    return utf8Encoder.encodeInto(string, view(buf, offset, offset + max))
        .written;
}

export function utf8ByteLength(string: string) {
    const length = string.length;
    let bytes = length;
    for (let i = 0; i < length; i++) {
        const c = string.charCodeAt(i);
        if (c < 0x80) continue;
        if (c < 0x800) {
            bytes += 1;
        } else if (
            c >= 0xd800 &&
            c <= 0xdbff &&
            i + 1 < length &&
            (string.charCodeAt(i + 1) & 0xfc00) === 0xdc00
        ) {
            // a pair: two units, four bytes
            bytes += 2;
            i++;
        } else {
            // the BMP from U+0800, and lone surrogates as U+FFFD
            bytes += 2;
        }
    }
    return bytes;
}

// latin1 and ascii

export function latin1Slice(buf: Uint8Array, start: number, end: number) {
    if (isAsciiRange(buf, start, end)) return utf8Slice(buf, start, end);
    return fromCharCodes(buf, start, end);
}

// Node clears the high bit
export function asciiSlice(buf: Uint8Array, start: number, end: number) {
    if (isAsciiRange(buf, start, end)) return utf8Slice(buf, start, end);
    const masked = new Uint8Array(end - start);
    for (let i = start; i < end; i++) masked[i - start] = buf[i] & 0x7f;
    return decode(masked);
}

// one byte per unit, the low byte; ascii writes the same as latin1
export function latin1Write(
    buf: Uint8Array,
    string: string,
    offset: number,
    max: number
) {
    const length = Math.min(string.length, max);
    for (let i = 0; i < length; i++) {
        buf[offset + i] = string.charCodeAt(i);
    }
    return length;
}

// utf16le

export function ucs2Slice(buf: Uint8Array, start: number, end: number) {
    const units = (end - start) >>> 1;
    if (units === 0) return "";
    const byteOffset = buf.byteOffset + start;
    let codes: Uint16Array;
    if (LITTLE_ENDIAN && (byteOffset & 1) === 0) {
        codes = new Uint16Array(buf.buffer, byteOffset, units);
    } else {
        codes = new Uint16Array(units);
        for (let i = 0; i < units; i++) {
            codes[i] = buf[start + 2 * i] | (buf[start + 2 * i + 1] << 8);
        }
    }
    return fromCharCodes(codes, 0, units);
}

export function ucs2Write(
    buf: Uint8Array,
    string: string,
    offset: number,
    max: number
) {
    const units = Math.min(string.length, max >>> 1);
    for (let i = 0; i < units; i++) {
        const c = string.charCodeAt(i);
        buf[offset + 2 * i] = c;
        buf[offset + 2 * i + 1] = c >>> 8;
    }
    return units * 2;
}

// hex

const HEX_DIGITS = "0123456789abcdef";
// the two characters of a byte, as they lie in memory in a Uint16Array
const HEX_PAIRS = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
    const hi = HEX_DIGITS.charCodeAt(i >>> 4);
    const lo = HEX_DIGITS.charCodeAt(i & 15);
    HEX_PAIRS[i] = LITTLE_ENDIAN ? hi | (lo << 8) : (hi << 8) | lo;
}
// value of a hex digit, -1 for anything else
const UNHEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) {
    UNHEX[HEX_DIGITS.charCodeAt(i)] = i;
    UNHEX[HEX_DIGITS.toUpperCase().charCodeAt(i)] = i;
}

export function hexSlice(buf: Uint8Array, start: number, end: number) {
    if (start === end) return "";
    if (hasToHex) return (view(buf, start, end) as NativeUint8Array).toHex();
    const length = end - start;
    const pairs = new Uint16Array(length);
    for (let i = 0; i < length; i++) pairs[i] = HEX_PAIRS[buf[start + i]];
    return decode(pairs);
}

// stops at the first pair that is not two hex digits, like nbytes; a unit
// is read as its low byte, as for base64 below
export function hexWrite(
    buf: Uint8Array,
    string: string,
    offset: number,
    max: number
) {
    const length = Math.min(max, string.length >>> 1);
    for (let i = 0; i < length; i++) {
        const value =
            (UNHEX[string.charCodeAt(2 * i) & 0xff] << 4) |
            UNHEX[string.charCodeAt(2 * i + 1) & 0xff];
        if (value < 0) return i;
        buf[offset + i] = value;
    }
    return length;
}

// the bytes of a string of hex digits, null when the engine cannot decode
// it whole (no fromHex, or an invalid digit: the caller's loop finds where
// Node stops)
export function hexToBytes(string: string): Uint8Array<ArrayBuffer> {
    if (!hasFromHex) return null;
    try {
        return NativeUint8Array.fromHex(
            string.length & 1 ? string.slice(0, -1) : string
        );
    } catch {
        return null;
    }
}

// base64

const BASE64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// value of a character in either alphabet, 64 for anything else: Node
// decodes base64 and base64url alike
const UNBASE64 = new Uint8Array(256).fill(64);
for (let i = 0; i < 64; i++) {
    UNBASE64[BASE64.charCodeAt(i)] = i;
    UNBASE64[BASE64URL.charCodeAt(i)] = i;
}

// 12 bits to their two characters, as they lie in memory in a Uint16Array,
// made on first use (only engines without toBase64 need them)
let base64Pairs: Uint16Array;
let base64urlPairs: Uint16Array;
function makePairs(alphabet: string) {
    const pairs = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) {
        const hi = alphabet.charCodeAt(i >>> 6);
        const lo = alphabet.charCodeAt(i & 63);
        pairs[i] = LITTLE_ENDIAN ? hi | (lo << 8) : (hi << 8) | lo;
    }
    return pairs;
}

export function base64Slice(
    buf: Uint8Array,
    start: number,
    end: number,
    url = false
) {
    if (start === end) return "";
    if (hasToBase64) {
        return (view(buf, start, end) as NativeUint8Array).toBase64(
            url ? { alphabet: "base64url", omitPadding: true } : undefined
        );
    }

    const alphabet = url ? BASE64URL : BASE64;
    const pairs = url
        ? (base64urlPairs ??= makePairs(BASE64URL))
        : (base64Pairs ??= makePairs(BASE64));
    const length = end - start;
    const groups = Math.ceil(length / 3);
    const out16 = new Uint16Array(groups * 2);
    const out = new Uint8Array(out16.buffer);
    const full = start + length - (length % 3);
    let j = 0;
    let i = start;
    for (; i < full; i += 3) {
        const v = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
        out16[j++] = pairs[v >>> 12];
        out16[j++] = pairs[v & 0xfff];
    }
    let outLength = groups * 4;
    if (i < end) {
        const v = (buf[i] << 16) | (i + 1 < end ? buf[i + 1] << 8 : 0);
        const k = j * 2;
        out[k] = alphabet.charCodeAt(v >>> 18);
        out[k + 1] = alphabet.charCodeAt((v >>> 12) & 63);
        if (i + 1 < end) {
            out[k + 2] = alphabet.charCodeAt((v >>> 6) & 63);
            out[k + 3] = 0x3d;
            if (url) outLength -= 1;
        } else {
            out[k + 2] = out[k + 3] = 0x3d;
            if (url) outLength -= 2;
        }
    }
    return decode(outLength === out.length ? out : out.subarray(0, outLength));
}

// Buffer.byteLength(string, "base64"): an upper bound
export function base64ByteLength(string: string) {
    let bytes = string.length;
    if (string.charCodeAt(bytes - 1) === 0x3d) bytes--;
    if (bytes > 1 && string.charCodeAt(bytes - 1) === 0x3d) bytes--;
    return (bytes * 3) >>> 2;
}

// Node's lenient decoder (nbytes Base64Decode): characters outside both
// alphabets are skipped, a `=` stops decoding, a trailing partial group
// gives what its bits hold. A unit is read as its low byte, as nbytes casts
// the UTF-16 units to uint8_t ("Ł", U+0141, reads as "A").
export function base64Write(
    buf: Uint8Array,
    string: string,
    offset: number,
    max: number
) {
    const length = string.length;
    const end = offset + max;
    let i = 0;
    let k = offset;
    for (;;) {
        // whole groups of four valid characters
        while (i + 4 <= length && k + 3 <= end) {
            const a = UNBASE64[string.charCodeAt(i) & 0xff];
            const b = UNBASE64[string.charCodeAt(i + 1) & 0xff];
            const c = UNBASE64[string.charCodeAt(i + 2) & 0xff];
            const d = UNBASE64[string.charCodeAt(i + 3) & 0xff];
            if ((a | b | c | d) & 64) break;
            buf[k] = (a << 2) | (b >>> 4);
            buf[k + 1] = (b << 4) | (c >>> 2);
            buf[k + 2] = (c << 6) | d;
            i += 4;
            k += 3;
        }
        if (i >= length || k >= end) return k - offset;

        // one group character by character (nbytes base64_decode_group_slow)
        let hi = 0;
        for (let n = 0; n < 4; n++) {
            let lo: number;
            for (;;) {
                const c = string.charCodeAt(i++) & 0xff;
                lo = UNBASE64[c];
                if (lo < 64) break;
                if (c === 0x3d || i >= length) return k - offset;
            }
            if (n === 1) buf[k++] = (hi << 2) | (lo >>> 4);
            else if (n === 2) buf[k++] = (hi << 4) | (lo >>> 2);
            else if (n === 3) buf[k++] = (hi << 6) | lo;
            if (i >= length || k >= end) return k - offset;
            hi = lo;
        }
    }
}

// the bytes of a base64 string, null when the engine cannot decode it (no
// fromBase64, or input outside the WHATWG forgiving-base64 grammar: Node's
// lenient decoder, above, gives the same bytes on everything that grammar
// accepts and decides the rest)
export function base64ToBytes(
    string: string,
    url: boolean
): Uint8Array<ArrayBuffer> {
    if (!hasFromBase64) return null;
    try {
        return NativeUint8Array.fromBase64(
            string,
            url ? { alphabet: "base64url" } : undefined
        );
    } catch {
        return null;
    }
}

// lib/internal/util.js normalizeEncoding: the canonical name, undefined for
// an unknown encoding
const ENCODINGS: Record<string, string> = Object.assign(Object.create(null), {
    utf8: "utf8",
    "utf-8": "utf8",
    ucs2: "utf16le",
    "ucs-2": "utf16le",
    utf16le: "utf16le",
    "utf-16le": "utf16le",
    latin1: "latin1",
    binary: "latin1",
    base64: "base64",
    base64url: "base64url",
    hex: "hex",
    ascii: "ascii"
});

export function normalizeEncoding(encoding: unknown): string | undefined {
    if (encoding == null || encoding === "utf8" || encoding === "utf-8") {
        return "utf8";
    }
    if (typeof encoding !== "string" && !(encoding instanceof String)) {
        return undefined;
    }
    const name = `${encoding}`;
    if (name === "") return "utf8";
    return ENCODINGS[name] ?? ENCODINGS[name.toLowerCase()];
}
