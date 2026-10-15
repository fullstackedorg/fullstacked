// SHA-1 (FIPS 180-4, sections 5.3.1 and 6.1) on Uint8Arrays, for
// createHash("sha1") and the hmac-sha1 MACs that ssh2 still negotiates.
// Same layout as sha256.ts: int32 state, big-endian words read from the
// input, a module-level message schedule.

import type { TsHash } from "./index.ts";
import { writeBitLength } from "./sha256.ts";

const IV = new Int32Array([
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0
]);

// scratch for one call of compress, shared by every instance (see sha256.ts)
const W = new Int32Array(80);

// hashes `blocks` 64-byte blocks of m starting at p into s; binary additions
// and the schedule computed in the round that uses it, as in sha256.ts
function compress(s: Int32Array, m: Uint8Array, p: number, blocks: number) {
    const w = W;
    for (; blocks > 0; blocks--) {
        let a = s[0],
            b = s[1],
            c = s[2],
            d = s[3],
            e = s[4];
        for (let i = 0; i < 80; i++) {
            let x: number;
            if (i < 16) {
                x =
                    (m[p] << 24) |
                    (m[p + 1] << 16) |
                    (m[p + 2] << 8) |
                    m[p + 3];
                p += 4;
            } else {
                x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
                x = (x << 1) | (x >>> 31);
            }
            w[i] = x;
            // the function and constant of each group of 20 rounds; the
            // branches are taken the same way 19 times out of 20
            let f: number;
            if (i < 20) f = ((d ^ (b & (c ^ d))) + 0x5a827999) | 0;
            else if (i < 40) f = ((b ^ c ^ d) + 0x6ed9eba1) | 0;
            else if (i < 60) f = (((b & c) | (d & (b | c))) - 0x70e44324) | 0;
            else f = ((b ^ c ^ d) - 0x359d3e2a) | 0;
            let t = (((a << 5) | (a >>> 27)) + e) | 0;
            t = (t + x) | 0;
            e = d;
            d = c;
            c = (b << 30) | (b >>> 2);
            b = a;
            a = (t + f) | 0;
        }
        s[0] = (s[0] + a) | 0;
        s[1] = (s[1] + b) | 0;
        s[2] = (s[2] + c) | 0;
        s[3] = (s[3] + d) | 0;
        s[4] = (s[4] + e) | 0;
    }
}

export class Sha1 implements TsHash {
    readonly blockSize = 64;
    readonly outputLength = 20;
    private readonly state: Int32Array;
    private readonly buffer: Uint8Array;
    private fill = 0;
    private bytes = 0;

    constructor(from?: Sha1) {
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
            compress(this.state, buffer, 0, 1);
            fill = 0;
        }
        const blocks = Math.floor((length - p) / 64);
        if (blocks > 0) {
            compress(this.state, data, p, blocks);
            p += blocks * 64;
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
            compress(state, buffer, 0, 1);
            fill = 0;
        }
        buffer.fill(0, fill, 56);
        writeBitLength(buffer, 56, this.bytes);
        compress(state, buffer, 0, 1);
        const out = new Uint8Array(20);
        for (let i = 0, j = 0; i < 5; i++, j += 4) {
            const v = state[i];
            out[j] = v >>> 24;
            out[j + 1] = v >>> 16;
            out[j + 2] = v >>> 8;
            out[j + 3] = v;
        }
        return out;
    }

    copy() {
        return new Sha1(this);
    }
}
