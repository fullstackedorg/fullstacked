// node:string_decoder, the algorithm of Node 22's src/string_decoder.cc: a
// character cut at the end of a chunk is kept (up to 4 bytes) and finished
// with the next one. Where that decides how output splits across write()
// calls (an invalid utf8 continuation, a utf16 surrogate pair), it is the
// C++ decoder's choice that is reproduced, not TextDecoder's streaming one.

import {
    asciiSlice,
    base64Slice,
    hexSlice,
    latin1Slice,
    normalizeEncoding,
    ucs2Slice,
    utf8Slice
} from "../buffer/codecs.ts";
import { Buffer } from "../buffer/index.ts";
import {
    ERR_INVALID_ARG_TYPE,
    ERR_UNKNOWN_ENCODING
} from "../buffer/errors.ts";

type Decode = (bytes: Uint8Array, start: number, end: number) => string;

const DECODERS: Record<string, Decode> = {
    utf8: utf8Slice,
    utf16le: ucs2Slice,
    latin1: latin1Slice,
    ascii: asciiSlice,
    hex: hexSlice,
    base64: (bytes, start, end) => base64Slice(bytes, start, end),
    base64url: (bytes, start, end) => base64Slice(bytes, start, end, true)
};

export class StringDecoder {
    readonly encoding: BufferEncoding;

    #decode: Decode;
    // the bytes of the character being completed
    #incomplete: Uint8Array = Buffer.alloc(4);
    #missing = 0;
    #buffered = 0;

    constructor(encoding?: BufferEncoding | string) {
        const normalized = normalizeEncoding(encoding);
        if (normalized === undefined) throw ERR_UNKNOWN_ENCODING(encoding);
        this.encoding = normalized as BufferEncoding;
        this.#decode = DECODERS[normalized];
    }

    write(buf: ArrayBufferView | string): string {
        if (typeof buf === "string") return buf;
        if (!ArrayBuffer.isView(buf)) {
            throw ERR_INVALID_ARG_TYPE(
                "buf",
                ["Buffer", "TypedArray", "DataView"],
                buf
            );
        }
        return this.#write(
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        );
    }

    end(buf?: ArrayBufferView | string): string {
        let ret = "";
        if (buf !== undefined) ret = this.write(buf);
        if (this.#buffered > 0) ret += this.#flush();
        return ret;
    }

    // undocumented legacy, as in Node
    text(buf: Uint8Array, offset: number): string {
        this.#missing = 0;
        this.#buffered = 0;
        return this.write(buf.subarray(offset));
    }

    get lastChar(): Uint8Array {
        return this.#incomplete;
    }

    get lastNeed(): number {
        return this.#missing;
    }

    get lastTotal(): number {
        return this.#buffered + this.#missing;
    }

    // StringDecoder::DecodeData
    #write(data: Uint8Array): string {
        const encoding = this.encoding;
        if (
            encoding === "ascii" ||
            encoding === "hex" ||
            encoding === "latin1"
        ) {
            return this.#decode(data, 0, data.length);
        }

        let start = 0;
        let length = data.length;
        let prepend = "";

        if (this.#missing > 0) {
            if (encoding === "utf8") {
                // a byte that is not a continuation ends the character
                // early, and starts a new one
                for (let i = 0; i < length && i < this.#missing; ++i) {
                    if ((data[i] & 0xc0) !== 0x80) {
                        this.#missing = 0;
                        this.#incomplete.set(
                            data.subarray(0, i),
                            this.#buffered
                        );
                        this.#buffered += i;
                        start += i;
                        length -= i;
                        break;
                    }
                }
            }

            const found = Math.min(length, this.#missing);
            this.#incomplete.set(
                data.subarray(start, start + found),
                this.#buffered
            );
            start += found;
            length -= found;
            this.#missing -= found;
            this.#buffered += found;

            if (this.#missing === 0) {
                prepend = this.#decode(this.#incomplete, 0, this.#buffered);
                this.#buffered = 0;
            }
        }

        // finishing the previous character took the whole chunk
        if (length === 0) return prepend;

        const last = start + length - 1;
        if (encoding === "utf8" && data[last] & 0x80) {
            // where does the character of the last byte start
            for (let i = last; ; --i) {
                this.#buffered++;
                if ((data[i] & 0xc0) === 0x80) {
                    // a continuation: more than 3 of them, or no lead byte
                    // in the chunk, is nothing to wait for
                    if (this.#buffered >= 4 || i === start) {
                        this.#buffered = 0;
                        break;
                    }
                } else {
                    // a lead byte tells the length of its character
                    if ((data[i] & 0xe0) === 0xc0) this.#missing = 2;
                    else if ((data[i] & 0xf0) === 0xe0) this.#missing = 3;
                    else if ((data[i] & 0xf8) === 0xf0) this.#missing = 4;
                    else {
                        this.#buffered = 0;
                        break;
                    }
                    if (this.#buffered >= this.#missing) {
                        // complete, or invalid anyway
                        this.#missing = 0;
                        this.#buffered = 0;
                    }
                    this.#missing -= this.#buffered;
                    break;
                }
            }
        } else if (encoding === "utf16le") {
            if (length % 2 === 1) {
                // half a unit
                this.#buffered = 1;
                this.#missing = 1;
            } else if ((data[last] & 0xfc) === 0xd8) {
                // the high half of a surrogate pair
                this.#buffered = 2;
                this.#missing = 2;
            }
        } else if (encoding === "base64" || encoding === "base64url") {
            this.#buffered = length % 3;
            if (this.#buffered > 0) this.#missing = 3 - this.#buffered;
        }

        if (this.#buffered > 0) {
            length -= this.#buffered;
            this.#incomplete.set(
                data.subarray(start + length, start + length + this.#buffered)
            );
        }

        const body =
            length > 0 ? this.#decode(data, start, start + length) : "";
        return prepend ? prepend + body : body;
    }

    // StringDecoder::FlushData
    #flush(): string {
        if (this.encoding === "utf16le" && this.#buffered % 2 === 1) {
            // a trailing half unit is dropped
            this.#missing--;
            this.#buffered--;
        }
        if (this.#buffered === 0) return "";
        const ret = this.#decode(this.#incomplete, 0, this.#buffered);
        this.#missing = 0;
        this.#buffered = 0;
        return ret;
    }
}

const string_decoder = { StringDecoder };

export default string_decoder;
export { string_decoder as "module.exports" };
