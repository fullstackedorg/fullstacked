// SHA-224 and SHA-256 (FIPS 180-4, sections 5.3.2, 5.3.3 and 6.2) on
// Uint8Arrays, for createHash in the webview where a call to the core costs
// more than hashing a small input (improvements/shim/plan.md 3.2).
//
// The state lives in an Int32Array of 8 words and every operation is kept in
// int32 range (`| 0`) so the JITs stay on integer paths. Message words are
// assembled big-endian straight from the input bytes, whole blocks are hashed
// in place without copying, and only a trailing partial block goes through
// the per-instance 64-byte buffer.

import type { TsHash } from "./index.ts";

const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const IV256 = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19
]);
const IV224 = new Int32Array([
    0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511,
    0x64f98fa7, 0xbefa4fa4
]);

// The message schedule is scratch for one call of compress, which runs to
// completion without calling out: one module-level array serves every
// instance, and copy() has nothing of it to carry.
const W = new Int32Array(64);

// Hashes `blocks` 64-byte blocks of m starting at p into s.
//
// Every addition is a binary `(x + y) | 0`: JavaScriptCore keeps a chain like
// `(a + b + c) | 0` in a function with loops on overflow-checked adds and
// falls back to doubles after the first overflow (V8 does not care). The
// message schedule is computed in the round that consumes it, one loop
// over the 64 rounds, which both JITs keep in registers better than a
// separate pass or fully unrolled rounds.
function compress(s: Int32Array, m: Uint8Array, p: number, blocks: number) {
    const w = W;
    const k = K;
    for (; blocks > 0; blocks--) {
        let a = s[0],
            b = s[1],
            c = s[2],
            d = s[3],
            e = s[4],
            f = s[5],
            g = s[6],
            h = s[7];
        for (let i = 0; i < 64; i++) {
            let x: number;
            if (i < 16) {
                x =
                    (m[p] << 24) |
                    (m[p + 1] << 16) |
                    (m[p + 2] << 8) |
                    m[p + 3];
                p += 4;
            } else {
                // sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]
                const u = w[i - 15];
                const v = w[i - 2];
                x =
                    ((((v >>> 17) | (v << 15)) ^
                        ((v >>> 19) | (v << 13)) ^
                        (v >>> 10)) +
                        w[i - 7]) |
                    0;
                x =
                    (x +
                        (((u >>> 7) | (u << 25)) ^
                            ((u >>> 18) | (u << 14)) ^
                            (u >>> 3))) |
                    0;
                x = (x + w[i - 16]) | 0;
            }
            w[i] = x;
            // t1 = h + Sigma1(e) + Ch(e, f, g) + k[i] + w[i]
            let t1 =
                (h +
                    (((e >>> 6) | (e << 26)) ^
                        ((e >>> 11) | (e << 21)) ^
                        ((e >>> 25) | (e << 7)))) |
                0;
            t1 = (t1 + (g ^ (e & (f ^ g)))) | 0;
            t1 = (t1 + k[i]) | 0;
            t1 = (t1 + x) | 0;
            // t2 = Sigma0(a) + Maj(a, b, c)
            const t2 =
                ((((a >>> 2) | (a << 30)) ^
                    ((a >>> 13) | (a << 19)) ^
                    ((a >>> 22) | (a << 10))) +
                    ((a & b) | (c & (a | b)))) |
                0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        s[0] = (s[0] + a) | 0;
        s[1] = (s[1] + b) | 0;
        s[2] = (s[2] + c) | 0;
        s[3] = (s[3] + d) | 0;
        s[4] = (s[4] + e) | 0;
        s[5] = (s[5] + f) | 0;
        s[6] = (s[6] + g) | 0;
        s[7] = (s[7] + h) | 0;
    }
}

export class Sha256 implements TsHash {
    readonly blockSize = 64;
    readonly outputLength: number;
    private readonly state: Int32Array;
    private readonly buffer: Uint8Array;
    private fill = 0;
    private bytes = 0;

    constructor(outputLength: 28 | 32, from?: Sha256) {
        this.outputLength = outputLength;
        if (from) {
            this.state = from.state.slice();
            this.buffer = from.buffer.slice();
            this.fill = from.fill;
            this.bytes = from.bytes;
        } else {
            this.state = (outputLength === 32 ? IV256 : IV224).slice();
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
        const out = new Uint8Array(this.outputLength);
        for (let i = 0, j = 0; j < out.length; i++, j += 4) {
            const v = state[i];
            out[j] = v >>> 24;
            out[j + 1] = v >>> 16;
            out[j + 2] = v >>> 8;
            out[j + 3] = v;
        }
        return out;
    }

    copy() {
        return new Sha256(this.outputLength as 28 | 32, this);
    }
}

// the message length in bits, as a 64-bit big-endian integer at p; `bytes`
// is exact as a double up to 2^53
export function writeBitLength(out: Uint8Array, p: number, bytes: number) {
    const hi = Math.floor(bytes / 0x20000000);
    const lo = (bytes * 8) >>> 0;
    out[p] = hi >>> 24;
    out[p + 1] = hi >>> 16;
    out[p + 2] = hi >>> 8;
    out[p + 3] = hi;
    out[p + 4] = lo >>> 24;
    out[p + 5] = lo >>> 16;
    out[p + 6] = lo >>> 8;
    out[p + 7] = lo;
}
