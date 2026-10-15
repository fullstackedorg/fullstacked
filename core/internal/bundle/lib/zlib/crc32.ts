// zlib.crc32(data, value): CRC-32 (IEEE, zlib's), computed here: a bridge
// call would cost more than the table loop for any input a page passes.

import { Buffer } from "buffer";
import { ERR_INVALID_ARG_TYPE, validateInteger } from "../buffer/errors.ts";

let table: Int32Array;

function makeTable() {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
}

export function crc32(data: string | ArrayBufferView, value = 0): number {
    let bytes: Uint8Array;
    if (typeof data === "string") {
        bytes = Buffer.from(data, "utf8");
    } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        throw ERR_INVALID_ARG_TYPE(
            "data",
            ["Buffer", "TypedArray", "DataView", "string"],
            data
        );
    }
    validateInteger(value, "value", 0, 0xffffffff);
    if (!table) makeTable();

    // the running value is kept inverted, as zlib's crc32() does
    let crc = ~value;
    for (let i = 0; i < bytes.length; i++) {
        crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return ~crc >>> 0;
}
