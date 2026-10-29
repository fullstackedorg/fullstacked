// ChaCha20 (RFC 8439 section 2.4) as OpenSSL's raw "chacha20" cipher, which
// is what Node's createCipheriv("chacha20", key, iv) exposes: a 32-byte key
// and a 16-byte IV made of the initial block counter (4 bytes,
// little-endian) followed by the 12-byte nonce. Like OpenSSL, the counter
// carries into the first nonce word when it wraps instead of stopping at
// 2^32 blocks.
//
// The block function keeps the 16 state words in local variables and the
// double rounds written out. ChaCha20's words are little-endian, so on
// little-endian hosts (all of ours) a keystream block XORs into an
// Int32Array view of the output as 16 word operations.

import type { TsStreamCipher } from "./index.ts";

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const SLICE = 1 << 30;

// XORs one keystream block into out at p (a multiple of 64 from the start
// of the keystream) and advances the counter in s[12] (and s[13]). out32 is
// an Int32Array over out's bytes from out's start, when p is a multiple of 4
// and the host little-endian; without it the words are XORed in byte by
// byte.
//
// One block per call, the loop over blocks in the caller: with the loop in
// here, a first call on a large input gets this function compiled by
// on-stack replacement, and V8 keeps running that code for the next calls
// at half the speed of a regular compilation (measured with Maglev; gone
// with --no-maglev).
function xorBlock(
    s: Int32Array,
    out: Uint8Array,
    out32: Int32Array | null,
    p: number
) {
    let x0 = s[0];
    let x1 = s[1];
    let x2 = s[2];
    let x3 = s[3];
    let x4 = s[4];
    let x5 = s[5];
    let x6 = s[6];
    let x7 = s[7];
    let x8 = s[8];
    let x9 = s[9];
    let x10 = s[10];
    let x11 = s[11];
    let x12 = s[12];
    let x13 = s[13];
    let x14 = s[14];
    let x15 = s[15];
    for (let i = 0; i < 10; i++) {
        // columns
        x0 = (x0 + x4) | 0;
        x12 ^= x0;
        x12 = (x12 << 16) | (x12 >>> 16);
        x8 = (x8 + x12) | 0;
        x4 ^= x8;
        x4 = (x4 << 12) | (x4 >>> 20);
        x0 = (x0 + x4) | 0;
        x12 ^= x0;
        x12 = (x12 << 8) | (x12 >>> 24);
        x8 = (x8 + x12) | 0;
        x4 ^= x8;
        x4 = (x4 << 7) | (x4 >>> 25);
        x1 = (x1 + x5) | 0;
        x13 ^= x1;
        x13 = (x13 << 16) | (x13 >>> 16);
        x9 = (x9 + x13) | 0;
        x5 ^= x9;
        x5 = (x5 << 12) | (x5 >>> 20);
        x1 = (x1 + x5) | 0;
        x13 ^= x1;
        x13 = (x13 << 8) | (x13 >>> 24);
        x9 = (x9 + x13) | 0;
        x5 ^= x9;
        x5 = (x5 << 7) | (x5 >>> 25);
        x2 = (x2 + x6) | 0;
        x14 ^= x2;
        x14 = (x14 << 16) | (x14 >>> 16);
        x10 = (x10 + x14) | 0;
        x6 ^= x10;
        x6 = (x6 << 12) | (x6 >>> 20);
        x2 = (x2 + x6) | 0;
        x14 ^= x2;
        x14 = (x14 << 8) | (x14 >>> 24);
        x10 = (x10 + x14) | 0;
        x6 ^= x10;
        x6 = (x6 << 7) | (x6 >>> 25);
        x3 = (x3 + x7) | 0;
        x15 ^= x3;
        x15 = (x15 << 16) | (x15 >>> 16);
        x11 = (x11 + x15) | 0;
        x7 ^= x11;
        x7 = (x7 << 12) | (x7 >>> 20);
        x3 = (x3 + x7) | 0;
        x15 ^= x3;
        x15 = (x15 << 8) | (x15 >>> 24);
        x11 = (x11 + x15) | 0;
        x7 ^= x11;
        x7 = (x7 << 7) | (x7 >>> 25);
        // diagonals
        x0 = (x0 + x5) | 0;
        x15 ^= x0;
        x15 = (x15 << 16) | (x15 >>> 16);
        x10 = (x10 + x15) | 0;
        x5 ^= x10;
        x5 = (x5 << 12) | (x5 >>> 20);
        x0 = (x0 + x5) | 0;
        x15 ^= x0;
        x15 = (x15 << 8) | (x15 >>> 24);
        x10 = (x10 + x15) | 0;
        x5 ^= x10;
        x5 = (x5 << 7) | (x5 >>> 25);
        x1 = (x1 + x6) | 0;
        x12 ^= x1;
        x12 = (x12 << 16) | (x12 >>> 16);
        x11 = (x11 + x12) | 0;
        x6 ^= x11;
        x6 = (x6 << 12) | (x6 >>> 20);
        x1 = (x1 + x6) | 0;
        x12 ^= x1;
        x12 = (x12 << 8) | (x12 >>> 24);
        x11 = (x11 + x12) | 0;
        x6 ^= x11;
        x6 = (x6 << 7) | (x6 >>> 25);
        x2 = (x2 + x7) | 0;
        x13 ^= x2;
        x13 = (x13 << 16) | (x13 >>> 16);
        x8 = (x8 + x13) | 0;
        x7 ^= x8;
        x7 = (x7 << 12) | (x7 >>> 20);
        x2 = (x2 + x7) | 0;
        x13 ^= x2;
        x13 = (x13 << 8) | (x13 >>> 24);
        x8 = (x8 + x13) | 0;
        x7 ^= x8;
        x7 = (x7 << 7) | (x7 >>> 25);
        x3 = (x3 + x4) | 0;
        x14 ^= x3;
        x14 = (x14 << 16) | (x14 >>> 16);
        x9 = (x9 + x14) | 0;
        x4 ^= x9;
        x4 = (x4 << 12) | (x4 >>> 20);
        x3 = (x3 + x4) | 0;
        x14 ^= x3;
        x14 = (x14 << 8) | (x14 >>> 24);
        x9 = (x9 + x14) | 0;
        x4 ^= x9;
        x4 = (x4 << 7) | (x4 >>> 25);
    }
    x0 = (x0 + s[0]) | 0;
    x1 = (x1 + s[1]) | 0;
    x2 = (x2 + s[2]) | 0;
    x3 = (x3 + s[3]) | 0;
    x4 = (x4 + s[4]) | 0;
    x5 = (x5 + s[5]) | 0;
    x6 = (x6 + s[6]) | 0;
    x7 = (x7 + s[7]) | 0;
    x8 = (x8 + s[8]) | 0;
    x9 = (x9 + s[9]) | 0;
    x10 = (x10 + s[10]) | 0;
    x11 = (x11 + s[11]) | 0;
    x12 = (x12 + s[12]) | 0;
    x13 = (x13 + s[13]) | 0;
    x14 = (x14 + s[14]) | 0;
    x15 = (x15 + s[15]) | 0;
    if (out32 !== null) {
        const q = p >> 2;
        out32[q] ^= x0;
        out32[q + 1] ^= x1;
        out32[q + 2] ^= x2;
        out32[q + 3] ^= x3;
        out32[q + 4] ^= x4;
        out32[q + 5] ^= x5;
        out32[q + 6] ^= x6;
        out32[q + 7] ^= x7;
        out32[q + 8] ^= x8;
        out32[q + 9] ^= x9;
        out32[q + 10] ^= x10;
        out32[q + 11] ^= x11;
        out32[q + 12] ^= x12;
        out32[q + 13] ^= x13;
        out32[q + 14] ^= x14;
        out32[q + 15] ^= x15;
    } else {
        xorWord(out, p, x0);
        xorWord(out, p + 4, x1);
        xorWord(out, p + 8, x2);
        xorWord(out, p + 12, x3);
        xorWord(out, p + 16, x4);
        xorWord(out, p + 20, x5);
        xorWord(out, p + 24, x6);
        xorWord(out, p + 28, x7);
        xorWord(out, p + 32, x8);
        xorWord(out, p + 36, x9);
        xorWord(out, p + 40, x10);
        xorWord(out, p + 44, x11);
        xorWord(out, p + 48, x12);
        xorWord(out, p + 52, x13);
        xorWord(out, p + 56, x14);
        xorWord(out, p + 60, x15);
    }
    // OpenSSL's 32-bit counter, carried into the nonce (see above)
    const counter = (s[12] + 1) | 0;
    s[12] = counter;
    if (counter === 0) s[13] = (s[13] + 1) | 0;
}

function xorWord(out: Uint8Array, p: number, v: number) {
    out[p] ^= v;
    out[p + 1] ^= v >>> 8;
    out[p + 2] ^= v >>> 16;
    out[p + 3] ^= v >>> 24;
}

export class ChaCha20 implements TsStreamCipher {
    // constants, key, counter, nonce (RFC 8439 2.3)
    private readonly state = new Int32Array(16);
    // the keystream of the current block and how much of it is used
    private readonly ks32 = new Int32Array(16);
    private readonly ks = new Uint8Array(this.ks32.buffer);
    private used = 64;

    // key of 32 bytes, iv of 16; the caller checks the lengths
    constructor(key: Uint8Array, iv: Uint8Array) {
        const s = this.state;
        // "expand 32-byte k"
        s[0] = 0x61707865;
        s[1] = 0x3320646e;
        s[2] = 0x79622d32;
        s[3] = 0x6b206574;
        for (let i = 0; i < 8; i++) s[4 + i] = readLE(key, i * 4);
        for (let i = 0; i < 4; i++) s[12 + i] = readLE(iv, i * 4);
    }

    update(data: Uint8Array): Uint8Array {
        const length = data.length;
        // offsets are int32 below (p >> 2): larger inputs go in slices
        if (length > SLICE) {
            const out = new Uint8Array(length);
            for (let i = 0; i < length; i += SLICE) {
                out.set(this.update(data.subarray(i, i + SLICE)), i);
            }
            return out;
        }
        const out = new Uint8Array(length);
        out.set(data);
        const ks = this.ks;
        let used = this.used;
        let p = 0;
        while (used < 64 && p < length) out[p++] ^= ks[used++];
        const blocks = (length - p) >>> 6;
        if (blocks > 0) {
            const out32 =
                LITTLE_ENDIAN && (p & 3) === 0
                    ? new Int32Array(out.buffer, 0, length >> 2)
                    : null;
            const state = this.state;
            for (let i = 0; i < blocks; i++, p += 64) {
                xorBlock(state, out, out32, p);
            }
        }
        if (p < length) {
            // the next block's keystream: XORed into zeros, kept for later
            this.ks32.fill(0);
            xorBlock(this.state, ks, LITTLE_ENDIAN ? this.ks32 : null, 0);
            used = 0;
            while (p < length) out[p++] ^= ks[used++];
        }
        this.used = used;
        return out;
    }
}

function readLE(b: Uint8Array, p: number) {
    return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
}
