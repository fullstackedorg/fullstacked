// MD5 (RFC 1321) on Uint8Arrays, for createHash("md5") in the webview.
//
// The 64 steps run in a loop, not written out as SHA-1 and SHA-2 are: MD5
// is not on a per-packet path (pg hashes a password per connection), and
// the unrolled form was a tenth of lib/crypto's size (improvements/shim/plan.md, Stage
// 4 size target). The additive constants are T[i] = floor(abs(sin(i + 1))
// * 2^32) of RFC 1321 section 3.4, computed once. Message words are
// little-endian, assembled from the input bytes.

import type { TsHash } from "./index.ts";

const IV = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);

const T = new Int32Array(64);
for (let i = 0; i < 64; i++) {
    T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
}

// the rotation of each step: 4 per round
const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

const X = new Int32Array(16);

// Hashes the 64-byte block of m at p into s
function compress(s: Int32Array, m: Uint8Array, p: number) {
    const x = X;
    for (let i = 0; i < 16; i++, p += 4) {
        x[i] = m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24);
    }
    let a = s[0],
        b = s[1],
        c = s[2],
        d = s[3];
    for (let i = 0; i < 64; i++) {
        const round = i >> 4;
        let f: number, g: number;
        if (round === 0) {
            f = d ^ (b & (c ^ d));
            g = i;
        } else if (round === 1) {
            f = c ^ (d & (b ^ c));
            g = (5 * i + 1) & 15;
        } else if (round === 2) {
            f = b ^ c ^ d;
            g = (3 * i + 5) & 15;
        } else {
            f = c ^ (b | ~d);
            g = (7 * i) & 15;
        }
        const t = (a + f + x[g] + T[i]) | 0;
        const n = R[(round << 2) | (i & 3)];
        a = d;
        d = c;
        c = b;
        b = (b + ((t << n) | (t >>> (32 - n)))) | 0;
    }
    s[0] = (s[0] + a) | 0;
    s[1] = (s[1] + b) | 0;
    s[2] = (s[2] + c) | 0;
    s[3] = (s[3] + d) | 0;
}

export class Md5 implements TsHash {
    readonly blockSize = 64;
    readonly outputLength = 16;
    private readonly state: Int32Array;
    private readonly buffer: Uint8Array;
    private fill = 0;
    private bytes = 0;

    constructor(from?: Md5) {
        if (from) {
            this.state = from.state.slice();
            this.buffer = from.buffer.slice();
            this.fill = from.fill;
            this.bytes = from.bytes;
        } else {
            this.state = IV.slice();
            this.buffer = new Uint8Array(64);
        }
    }

    update(data: Uint8Array) {
        const length = data.length;
        const buffer = this.buffer;
        let fill = this.fill;
        let p = 0;
        this.bytes += length;
        if (fill > 0) {
            while (fill < 64 && p < length) buffer[fill++] = data[p++];
            if (fill < 64) {
                this.fill = fill;
                return;
            }
            compress(this.state, buffer, 0);
            fill = 0;
        }
        const state = this.state;
        for (const end = length - 64; p <= end; p += 64) {
            compress(state, data, p);
        }
        while (p < length) buffer[fill++] = data[p++];
        this.fill = fill;
    }

    digest() {
        const buffer = this.buffer;
        const state = this.state;
        let fill = this.fill;
        buffer[fill++] = 0x80;
        if (fill > 56) {
            buffer.fill(0, fill);
            compress(state, buffer, 0);
            fill = 0;
        }
        buffer.fill(0, fill, 56);
        // the bit length, little-endian
        const bytes = this.bytes;
        const lo = (bytes * 8) >>> 0;
        const hi = Math.floor(bytes / 0x20000000);
        for (let i = 0; i < 4; i++) {
            buffer[56 + i] = lo >>> (i * 8);
            buffer[60 + i] = hi >>> (i * 8);
        }
        compress(state, buffer, 0);
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = state[i >> 2] >>> ((i & 3) * 8);
        return out;
    }

    copy() {
        return new Md5(this);
    }
}
