// node:querystring (Node 22), improvements/shim/plan.md 5.4: Node's algorithms, so that
// parse and stringify give the same strings for the same inputs, malformed
// percent sequences included.

import type * as NodeQuerystring from "node:querystring";
import { Buffer } from "../buffer/index.ts";

type ParsedQuery = { [key: string]: string | string[] };
type ParseOptions = {
    maxKeys?: number;
    decodeURIComponent?: (s: string) => string;
};
type StringifyOptions = { encodeURIComponent?: (s: string) => string };

// '%XX' for every byte
const hexTable: string[] = new Array(256);
for (let i = 0; i < 256; ++i) {
    hexTable[i] = "%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase();
}

// the value of a hex digit by char code, -1 for any other
const unhexTable = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; ++i) unhexTable[48 + i] = i;
for (let i = 0; i < 6; ++i) {
    unhexTable[65 + i] = unhexTable[97 + i] = 10 + i;
}

// the ASCII characters escape leaves as they are: ! ' ( ) * - . 0-9 A-Z _
// a-z ~ (encodeURIComponent's set)
const noEscape = new Int8Array(128);
for (const c of "!'()*-._~") noEscape[c.charCodeAt(0)] = 1;
for (let i = 48; i < 58; ++i) noEscape[i] = 1;
for (let i = 0; i < 26; ++i) noEscape[65 + i] = noEscape[97 + i] = 1;

function unescapeBuffer(s: string, decodeSpaces?: boolean): Buffer {
    const out = Buffer.allocUnsafe(s.length);
    let index = 0;
    let outIndex = 0;
    let currentChar: number;
    let hexHigh: number;
    let hexLow: number;
    const maxLength = s.length - 2;
    // whether some hex chars have been decoded
    let hasHex = false;
    while (index < s.length) {
        currentChar = s.charCodeAt(index);
        if (currentChar === 43 /* '+' */ && decodeSpaces) {
            out[outIndex++] = 32; // ' '
            index++;
            continue;
        }
        if (currentChar === 37 /* '%' */ && index < maxLength) {
            currentChar = s.charCodeAt(++index);
            hexHigh = unhexTable[currentChar];
            if (!(hexHigh >= 0)) {
                out[outIndex++] = 37; // '%'
                continue;
            }
            hexLow = unhexTable[s.charCodeAt(++index)];
            if (!(hexLow >= 0)) {
                out[outIndex++] = 37; // '%'
                index--;
            } else {
                hasHex = true;
                currentChar = hexHigh * 16 + hexLow;
            }
        }
        out[outIndex++] = currentChar;
        index++;
    }
    return hasHex ? out.slice(0, outIndex) : out;
}

// Buffer's utf8 toString, as WHATWG decodes it
const utf8 = new TextDecoder();

function unescape(s: string, decodeSpaces?: boolean): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return utf8.decode(querystring.unescapeBuffer(s, decodeSpaces));
    }
}

function invalidURI() {
    const error = new URIError("URI malformed") as URIError & {
        code: string;
    };
    error.code = "ERR_INVALID_URI";
    return error;
}

// Node's encodeStr: UTF-8 percent-encoding where only a high surrogate at
// the end of the string throws, any other lone surrogate is paired with
// the next code unit
function encodeStr(str: string): string {
    const len = str.length;
    if (len === 0) return "";
    let out = "";
    let lastPos = 0;
    let i = 0;
    outer: for (; i < len; i++) {
        let c = str.charCodeAt(i);
        // ASCII
        while (c < 0x80) {
            if (noEscape[c] !== 1) {
                if (lastPos < i) out += str.slice(lastPos, i);
                lastPos = i + 1;
                out += hexTable[c];
            }
            if (++i === len) break outer;
            c = str.charCodeAt(i);
        }
        if (lastPos < i) out += str.slice(lastPos, i);
        // multi-byte characters
        if (c < 0x800) {
            lastPos = i + 1;
            out += hexTable[0xc0 | (c >> 6)] + hexTable[0x80 | (c & 0x3f)];
            continue;
        }
        if (c < 0xd800 || c >= 0xe000) {
            lastPos = i + 1;
            out +=
                hexTable[0xe0 | (c >> 12)] +
                hexTable[0x80 | ((c >> 6) & 0x3f)] +
                hexTable[0x80 | (c & 0x3f)];
            continue;
        }
        // surrogate pair
        ++i;
        if (i >= len) throw invalidURI();
        const c2 = str.charCodeAt(i) & 0x3ff;
        lastPos = i + 1;
        c = 0x10000 + (((c & 0x3ff) << 10) | c2);
        out +=
            hexTable[0xf0 | (c >> 18)] +
            hexTable[0x80 | ((c >> 12) & 0x3f)] +
            hexTable[0x80 | ((c >> 6) & 0x3f)] +
            hexTable[0x80 | (c & 0x3f)];
    }
    if (lastPos === 0) return str;
    if (lastPos < len) return out + str.slice(lastPos);
    return out;
}

function escape(str: unknown): string {
    if (typeof str !== "string") {
        str = typeof str === "object" ? String(str) : str + "";
    }
    return encodeStr(str as string);
}

function stringifyPrimitive(v: unknown): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" && isFinite(v)) return "" + v;
    if (typeof v === "bigint") return "" + v;
    if (typeof v === "boolean") return v ? "true" : "false";
    return "";
}

function encodeStringified(v: unknown, encode: (s: string) => string) {
    if (typeof v === "string") return v.length ? encode(v) : "";
    if (typeof v === "number" && isFinite(v)) {
        // from 1e21 on the notation is scientific, with a '+' to escape
        return Math.abs(v) < 1e21 ? "" + v : encode("" + v);
    }
    if (typeof v === "bigint") return "" + v;
    if (typeof v === "boolean") return v ? "true" : "false";
    return "";
}

function encodeStringifiedCustom(v: unknown, encode: (s: string) => string) {
    return encode(stringifyPrimitive(v));
}

function stringify(
    obj: unknown,
    sep?: string,
    eq?: string,
    options?: StringifyOptions
): string {
    sep ||= "&";
    eq ||= "=";
    let encode = querystring.escape as (s: string) => string;
    if (options && typeof options.encodeURIComponent === "function") {
        encode = options.encodeURIComponent;
    }
    const convert =
        encode === escape ? encodeStringified : encodeStringifiedCustom;

    if (obj === null || typeof obj !== "object") return "";
    const keys = Object.keys(obj);
    let fields = "";
    for (let i = 0; i < keys.length; ++i) {
        const k = keys[i];
        const v = (obj as Record<string, unknown>)[k];
        const ks = convert(k, encode) + eq;
        if (Array.isArray(v)) {
            if (v.length === 0) continue;
            if (fields) fields += sep;
            for (let j = 0; j < v.length; ++j) {
                if (j) fields += sep;
                fields += ks + convert(v[j], encode);
            }
        } else {
            if (fields) fields += sep;
            fields += ks + convert(v, encode);
        }
    }
    return fields;
}

function charCodes(str: string): number[] {
    const codes: number[] = new Array(str.length);
    for (let i = 0; i < str.length; ++i) codes[i] = str.charCodeAt(i);
    return codes;
}

const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

function decodeStr(s: string, decoder: (s: string) => string) {
    try {
        return decoder(s);
    } catch {
        return querystring.unescape(s, true);
    }
}

function addKeyVal(
    obj: ParsedQuery,
    key: string,
    value: string,
    keyEncoded: boolean,
    valEncoded: boolean,
    decode: (s: string) => string
) {
    if (key.length > 0 && keyEncoded) key = decodeStr(key, decode);
    if (value.length > 0 && valEncoded) value = decodeStr(value, decode);
    const current = obj[key];
    if (current === undefined) {
        obj[key] = value;
    } else if (typeof current !== "string") {
        current.push(value);
    } else {
        obj[key] = [current, value];
    }
}

function parse(
    qs: string,
    sep?: string,
    eq?: string,
    options?: ParseOptions
): ParsedQuery {
    const obj: ParsedQuery = Object.create(null);
    if (typeof qs !== "string" || qs.length === 0) return obj;

    const sepCodes = !sep ? defSepCodes : charCodes(String(sep));
    const eqCodes = !eq ? defEqCodes : charCodes(String(eq));
    const sepLen = sepCodes.length;
    const eqLen = eqCodes.length;

    // -1: unlimited, `pairs` is only ever decremented and compared with 0
    let pairs = 1000;
    if (options && typeof options.maxKeys === "number") {
        pairs = options.maxKeys > 0 ? options.maxKeys : -1;
    }

    let decode = querystring.unescape as (s: string) => string;
    if (options && typeof options.decodeURIComponent === "function") {
        decode = options.decodeURIComponent;
    }
    const customDecode = decode !== unescape;

    let lastPos = 0;
    let sepIdx = 0;
    let eqIdx = 0;
    let key = "";
    let value = "";
    let keyEncoded = customDecode;
    let valEncoded = customDecode;
    const plusChar = customDecode ? "%20" : " ";
    let encodeCheck = 0;
    for (let i = 0; i < qs.length; ++i) {
        const code = qs.charCodeAt(i);

        // the key/value pair separator (e.g. '&')
        if (code === sepCodes[sepIdx]) {
            if (++sepIdx === sepLen) {
                const end = i - sepIdx + 1;
                if (eqIdx < eqLen) {
                    // no (entire) key/value separator: all of it is the key
                    if (lastPos < end) {
                        key += qs.slice(lastPos, end);
                    } else if (key.length === 0) {
                        // an empty substring between separators
                        if (--pairs === 0) return obj;
                        lastPos = i + 1;
                        sepIdx = eqIdx = 0;
                        continue;
                    }
                } else if (lastPos < end) {
                    value += qs.slice(lastPos, end);
                }

                addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

                if (--pairs === 0) return obj;
                keyEncoded = valEncoded = customDecode;
                key = value = "";
                encodeCheck = 0;
                lastPos = i + 1;
                sepIdx = eqIdx = 0;
            }
            continue;
        }
        sepIdx = 0;
        // the key/value separator (e.g. '='), if not found yet
        if (eqIdx < eqLen) {
            if (code === eqCodes[eqIdx]) {
                if (++eqIdx === eqLen) {
                    const end = i - eqIdx + 1;
                    if (lastPos < end) key += qs.slice(lastPos, end);
                    encodeCheck = 0;
                    lastPos = i + 1;
                }
                continue;
            }
            eqIdx = 0;
            if (!keyEncoded) {
                // decode the key only if it has a valid %XX
                if (code === 37 /* % */) {
                    encodeCheck = 1;
                    continue;
                } else if (encodeCheck > 0) {
                    if (unhexTable[code] >= 0) {
                        if (++encodeCheck === 3) keyEncoded = true;
                        continue;
                    }
                    encodeCheck = 0;
                }
            }
            if (code === 43 /* + */) {
                if (lastPos < i) key += qs.slice(lastPos, i);
                key += plusChar;
                lastPos = i + 1;
                continue;
            }
        }
        if (code === 43 /* + */) {
            if (lastPos < i) value += qs.slice(lastPos, i);
            value += plusChar;
            lastPos = i + 1;
        } else if (!valEncoded) {
            // decode the value only if it has a valid %XX
            if (code === 37 /* % */) {
                encodeCheck = 1;
            } else if (encodeCheck > 0) {
                if (unhexTable[code] >= 0) {
                    if (++encodeCheck === 3) valEncoded = true;
                } else {
                    encodeCheck = 0;
                }
            }
        }
    }

    // what is left of a key or value
    if (lastPos < qs.length) {
        if (eqIdx < eqLen) key += qs.slice(lastPos);
        else if (sepIdx < sepLen) value += qs.slice(lastPos);
    } else if (eqIdx === 0 && key.length === 0) {
        // ended on an empty substring
        return obj;
    }

    addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);
    return obj;
}

const decode = parse;
const encode = stringify;

// the functions go through this object, as Node's go through its exports:
// a replaced escape or unescape is the one parse and stringify use
const querystring = {
    unescapeBuffer,
    unescape,
    escape,
    stringify,
    encode,
    parse,
    decode
};

const exported = querystring as unknown as typeof NodeQuerystring & {
    unescapeBuffer: typeof unescapeBuffer;
};

export {
    unescapeBuffer,
    unescape,
    escape,
    stringify,
    encode,
    parse,
    decode,
    exported as default,
    exported as "module.exports"
};
