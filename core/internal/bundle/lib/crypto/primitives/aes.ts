// AES-128/192/256 encryption (FIPS 197) and CTR mode (NIST SP 800-38A,
// section 6.5) with OpenSSL's counter: the whole 16-byte IV is one 128-bit
// big-endian integer, incremented per block and wrapping at 2^128.
//
// The rounds use the classic T-tables (SubBytes, ShiftRows and MixColumns
// folded into four 256-entry lookups per column). Table lookups indexed by
// key-dependent bytes leak through cache timing; that is acceptable here
// because this code runs in the page that already holds the key and the
// data, on the user's own device, with no co-resident attacker to measure
// it. Work that needs constant time (keys, GCM, signatures) runs in Go.
//
// State words are little-endian (byte 0 of a column in the low bits), so the
// keystream lines up with an Int32Array view of the output on little-endian
// hosts (all of ours): a block XORs in as four word operations.

import type { TsStreamCipher } from "./index.ts";

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const SLICE = 1 << 30;

const SBOX = new Uint8Array(256);
const T0 = new Int32Array(256);
const T1 = new Int32Array(256);
const T2 = new Int32Array(256);
const T3 = new Int32Array(256);

// The S-box from its definition (inverse in GF(2^8), then the affine map),
// walking the multiplicative group with generator 3: p runs over 3^i and q
// over its inverse 3^-i.
{
    let p = 1;
    let q = 1;
    do {
        p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
        q ^= q << 1;
        q ^= q << 2;
        q ^= q << 4;
        q &= 0xff;
        if (q & 0x80) q ^= 0x09;
        const x = q ^ (q << 1) ^ (q << 2) ^ (q << 3) ^ (q << 4);
        SBOX[p] = (x ^ (x >> 8) ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) {
        const s = SBOX[i];
        const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
        // the MixColumns column (2s, s, s, 3s) for a byte in row 0; the
        // other rows are the same column rotated down
        const t = s2 | (s << 8) | (s << 16) | ((s2 ^ s) << 24);
        T0[i] = t;
        T1[i] = (t << 8) | (t >>> 24);
        T2[i] = (t << 16) | (t >>> 16);
        T3[i] = (t << 24) | (t >>> 8);
    }
}

// the round keys, 4 * (rounds + 1) little-endian words (FIPS 197 5.2)
function expandKey(key: Uint8Array): Int32Array {
    const nk = key.length >> 2;
    const rounds = nk + 6;
    const w = new Int32Array(4 * (rounds + 1));
    for (let i = 0; i < nk; i++) {
        const p = i * 4;
        w[i] =
            key[p] |
            (key[p + 1] << 8) |
            (key[p + 2] << 16) |
            (key[p + 3] << 24);
    }
    let rcon = 1;
    for (let i = nk; i < w.length; i++) {
        let t = w[i - 1];
        if (i % nk === 0) {
            // RotWord is a right rotation in little-endian words
            t = (t >>> 8) | (t << 24);
            t = subWord(t) ^ rcon;
            rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
        } else if (nk > 6 && i % nk === 4) {
            t = subWord(t);
        }
        w[i] = w[i - nk] ^ t;
    }
    return w;
}

function subWord(t: number) {
    return (
        SBOX[t & 255] |
        (SBOX[(t >>> 8) & 255] << 8) |
        (SBOX[(t >>> 16) & 255] << 16) |
        (SBOX[t >>> 24] << 24)
    );
}

// XORs one keystream block into out at p (a multiple of 16 from the start
// of the keystream) and advances the counter. out32 is an Int32Array over
// out's bytes from out's start, when p is a multiple of 4 and the host
// little-endian; without it the words are XORed in byte by byte.
//
// ctr holds the counter twice: as four big-endian words (ctr[3] the least
// significant), which is how it increments, and byte-swapped in ctr[4..7],
// which is the state's little-endian layout. Only the low word changes on
// most blocks.
//
// One block per call, the loop over blocks in the caller: with the loop in
// here, a first call on a large input gets this function compiled by
// on-stack replacement, and V8 keeps running that code at a fraction of the
// speed of a regular compilation (measured with Maglev).
function xorBlock(
    rk: Int32Array,
    ctr: Int32Array,
    out: Uint8Array,
    out32: Int32Array | null,
    p: number
) {
    const t0 = T0,
        t1 = T1,
        t2 = T2,
        t3 = T3,
        sbox = SBOX;
    const last = rk.length - 4;
    let s0 = ctr[4] ^ rk[0],
        s1 = ctr[5] ^ rk[1],
        s2 = ctr[6] ^ rk[2],
        s3 = ctr[7] ^ rk[3];
    // the 9, 11 or 13 middle rounds: one, then pairs from u to s and back,
    // so the state never moves between variables
    let u0 =
        t0[s0 & 255] ^
        t1[(s1 >>> 8) & 255] ^
        t2[(s2 >>> 16) & 255] ^
        t3[s3 >>> 24] ^
        rk[4];
    let u1 =
        t0[s1 & 255] ^
        t1[(s2 >>> 8) & 255] ^
        t2[(s3 >>> 16) & 255] ^
        t3[s0 >>> 24] ^
        rk[4 + 1];
    let u2 =
        t0[s2 & 255] ^
        t1[(s3 >>> 8) & 255] ^
        t2[(s0 >>> 16) & 255] ^
        t3[s1 >>> 24] ^
        rk[4 + 2];
    let u3 =
        t0[s3 & 255] ^
        t1[(s0 >>> 8) & 255] ^
        t2[(s1 >>> 16) & 255] ^
        t3[s2 >>> 24] ^
        rk[4 + 3];
    for (let k = 8; k < last; k += 8) {
        s0 =
            t0[u0 & 255] ^
            t1[(u1 >>> 8) & 255] ^
            t2[(u2 >>> 16) & 255] ^
            t3[u3 >>> 24] ^
            rk[k];
        s1 =
            t0[u1 & 255] ^
            t1[(u2 >>> 8) & 255] ^
            t2[(u3 >>> 16) & 255] ^
            t3[u0 >>> 24] ^
            rk[k + 1];
        s2 =
            t0[u2 & 255] ^
            t1[(u3 >>> 8) & 255] ^
            t2[(u0 >>> 16) & 255] ^
            t3[u1 >>> 24] ^
            rk[k + 2];
        s3 =
            t0[u3 & 255] ^
            t1[(u0 >>> 8) & 255] ^
            t2[(u1 >>> 16) & 255] ^
            t3[u2 >>> 24] ^
            rk[k + 3];
        u0 =
            t0[s0 & 255] ^
            t1[(s1 >>> 8) & 255] ^
            t2[(s2 >>> 16) & 255] ^
            t3[s3 >>> 24] ^
            rk[k + 4];
        u1 =
            t0[s1 & 255] ^
            t1[(s2 >>> 8) & 255] ^
            t2[(s3 >>> 16) & 255] ^
            t3[s0 >>> 24] ^
            rk[k + 4 + 1];
        u2 =
            t0[s2 & 255] ^
            t1[(s3 >>> 8) & 255] ^
            t2[(s0 >>> 16) & 255] ^
            t3[s1 >>> 24] ^
            rk[k + 4 + 2];
        u3 =
            t0[s3 & 255] ^
            t1[(s0 >>> 8) & 255] ^
            t2[(s1 >>> 16) & 255] ^
            t3[s2 >>> 24] ^
            rk[k + 4 + 3];
    }
    // the last round has no MixColumns
    const o0 =
        (sbox[u0 & 255] |
            (sbox[(u1 >>> 8) & 255] << 8) |
            (sbox[(u2 >>> 16) & 255] << 16) |
            (sbox[u3 >>> 24] << 24)) ^
        rk[last];
    const o1 =
        (sbox[u1 & 255] |
            (sbox[(u2 >>> 8) & 255] << 8) |
            (sbox[(u3 >>> 16) & 255] << 16) |
            (sbox[u0 >>> 24] << 24)) ^
        rk[last + 1];
    const o2 =
        (sbox[u2 & 255] |
            (sbox[(u3 >>> 8) & 255] << 8) |
            (sbox[(u0 >>> 16) & 255] << 16) |
            (sbox[u1 >>> 24] << 24)) ^
        rk[last + 2];
    const o3 =
        (sbox[u3 & 255] |
            (sbox[(u0 >>> 8) & 255] << 8) |
            (sbox[(u1 >>> 16) & 255] << 16) |
            (sbox[u2 >>> 24] << 24)) ^
        rk[last + 3];
    if (out32 !== null) {
        const q = p >> 2;
        out32[q] ^= o0;
        out32[q + 1] ^= o1;
        out32[q + 2] ^= o2;
        out32[q + 3] ^= o3;
    } else {
        xorWord(out, p, o0);
        xorWord(out, p + 4, o1);
        xorWord(out, p + 8, o2);
        xorWord(out, p + 12, o3);
    }
    // the 128-bit increment, with its carries
    const c3 = (ctr[3] + 1) | 0;
    ctr[3] = c3;
    ctr[7] = bswap(c3);
    if (c3 === 0) {
        for (let i = 2; i >= 0; i--) {
            const c = (ctr[i] + 1) | 0;
            ctr[i] = c;
            ctr[i + 4] = bswap(c);
            if (c !== 0) break;
        }
    }
}

function bswap(x: number) {
    return (x << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24);
}

function xorWord(out: Uint8Array, p: number, v: number) {
    out[p] ^= v;
    out[p + 1] ^= v >>> 8;
    out[p + 2] ^= v >>> 16;
    out[p + 3] ^= v >>> 24;
}

export class AesCtr implements TsStreamCipher {
    private readonly rk: Int32Array;
    // big-endian words, then their little-endian forms (see xorBlock)
    private readonly ctr = new Int32Array(8);
    // the keystream of the current block and how much of it is used
    private readonly ks32 = new Int32Array(4);
    private readonly ks = new Uint8Array(this.ks32.buffer);
    private used = 16;

    // key of 16, 24 or 32 bytes, iv of 16; the caller checks the lengths
    constructor(key: Uint8Array, iv: Uint8Array) {
        this.rk = expandKey(key);
        const ctr = this.ctr;
        for (let i = 0; i < 4; i++) {
            const p = i * 4;
            ctr[i] =
                (iv[p] << 24) |
                (iv[p + 1] << 16) |
                (iv[p + 2] << 8) |
                iv[p + 3];
            ctr[i + 4] = bswap(ctr[i]);
        }
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
        while (used < 16 && p < length) out[p++] ^= ks[used++];
        const blocks = (length - p) >>> 4;
        if (blocks > 0) {
            const out32 =
                LITTLE_ENDIAN && (p & 3) === 0
                    ? new Int32Array(out.buffer, 0, length >> 2)
                    : null;
            const rk = this.rk;
            const ctr = this.ctr;
            for (let i = 0; i < blocks; i++, p += 16) {
                xorBlock(rk, ctr, out, out32, p);
            }
        }
        if (p < length) {
            // the next block's keystream: XORed into zeros, kept for later
            this.ks32.fill(0);
            xorBlock(
                this.rk,
                this.ctr,
                ks,
                LITTLE_ENDIAN ? this.ks32 : null,
                0
            );
            used = 0;
            while (p < length) out[p++] ^= ks[used++];
        }
        this.used = used;
        return out;
    }
}
