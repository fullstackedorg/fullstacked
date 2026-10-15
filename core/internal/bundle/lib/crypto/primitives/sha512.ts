// SHA-384, SHA-512, SHA-512/224 and SHA-512/256 (FIPS 180-4, sections
// 5.3.4 to 5.3.6 and 6.4) on Uint8Arrays.
//
// JavaScript has no 64-bit integer arithmetic short of BigInt, which
// allocates on every operation, so each 64-bit word is a pair of int32
// halves (high, low), held in local variables during the rounds and
// interleaved high-then-low in the state and schedule arrays. Rotations
// combine the two halves with shifts; additions carry from the low half
// into the high one (see compress).

import type { TsHash } from "./index.ts";
import { writeBitLength } from "./sha256.ts";

// prettier-ignore
const K = new Int32Array([
    0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
    0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
    0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
    0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
    0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
    0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
    0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
    0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
    0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
    0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
    0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
    0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
    0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
    0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
    0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
    0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
    0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
    0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
    0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
    0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
]);

// prettier-ignore
const IV512 = new Int32Array([
    0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179
]);
// prettier-ignore
const IV384 = new Int32Array([
    0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
    0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4
]);
// prettier-ignore
const IV512_224 = new Int32Array([
    0x8c3d37c8, 0x19544da2, 0x73e19966, 0x89dcd4d6, 0x1dfab7ae, 0x32ff9c82, 0x679dd514, 0x582f9fcf,
    0x0f6d2b69, 0x7bd44da8, 0x77e36f73, 0x04c48942, 0x3f9d85a8, 0x6a1d36c8, 0x1112e6ad, 0x91d692a1
]);
// prettier-ignore
const IV512_256 = new Int32Array([
    0x22312194, 0xfc2bf72c, 0x9f555fa3, 0xc84c64c2, 0x2393b86b, 0x6f53b151, 0x96387719, 0x5940eabd,
    0x96283ee2, 0xa88effe3, 0xbe5e1e25, 0x53863992, 0x2b0199fc, 0x2c85b8aa, 0x0eb72ddc, 0x81c52ca2
]);

const IVS: Record<number, Int32Array> = {
    28: IV512_224,
    32: IV512_256,
    48: IV384,
    64: IV512
};

// scratch for one call of compress, shared by every instance (see sha256.ts)
const W = new Int32Array(160);

// A 64-bit addition (xh, xl) + (yh, yl) adds the halves separately and the
// carry out of the low one into the high one. The carry comes from the sign
// bits of the operands and of the int32 sum l: set when both operands have
// the top bit, or one has it and the sum lost it:
//
//     carry = ((xl & yl) | ((xl | yl) & ~l)) >>> 31
//
// Integer-only on purpose: summing the low halves as unsigned doubles is fast
// in V8 but makes JavaScriptCore's optimizer recompile the function over and
// over. Every addition is binary and truncated for the same engine (see
// sha256.ts).

// hashes `blocks` 128-byte blocks of m starting at p into s
function compress(s: Int32Array, m: Uint8Array, p: number, blocks: number) {
    const w = W;
    const k = K;
    for (; blocks > 0; blocks--) {
        let ah = s[0],
            al = s[1],
            bh = s[2],
            bl = s[3],
            ch = s[4],
            cl = s[5],
            dh = s[6],
            dl = s[7],
            eh = s[8],
            el = s[9],
            fh = s[10],
            fl = s[11],
            gh = s[12],
            gl = s[13],
            hh = s[14],
            hl = s[15];
        for (let i = 0; i < 160; i += 2) {
            // the schedule word w[t], t = i / 2
            let xh: number, xl: number;
            if (i < 32) {
                xh =
                    (m[p] << 24) |
                    (m[p + 1] << 16) |
                    (m[p + 2] << 8) |
                    m[p + 3];
                xl =
                    (m[p + 4] << 24) |
                    (m[p + 5] << 16) |
                    (m[p + 6] << 8) |
                    m[p + 7];
                p += 8;
            } else {
                // sigma1(w[t - 2]): rotr 19, rotr 61, shr 6
                let uh = w[i - 4];
                let ul = w[i - 3];
                const s1h =
                    ((uh >>> 19) | (ul << 13)) ^
                    ((ul >>> 29) | (uh << 3)) ^
                    (uh >>> 6);
                const s1l =
                    ((ul >>> 19) | (uh << 13)) ^
                    ((uh >>> 29) | (ul << 3)) ^
                    ((ul >>> 6) | (uh << 26));
                // sigma0(w[t - 15]): rotr 1, rotr 8, shr 7
                uh = w[i - 30];
                ul = w[i - 29];
                const s0h =
                    ((uh >>> 1) | (ul << 31)) ^
                    ((uh >>> 8) | (ul << 24)) ^
                    (uh >>> 7);
                const s0l =
                    ((ul >>> 1) | (uh << 31)) ^
                    ((ul >>> 8) | (uh << 24)) ^
                    ((ul >>> 7) | (uh << 25));
                // sigma1 + w[t - 7]
                let yl = w[i - 13];
                const l1 = (s1l + yl) | 0;
                let h1 = (s1h + w[i - 14]) | 0;
                h1 = (h1 + (((s1l & yl) | ((s1l | yl) & ~l1)) >>> 31)) | 0;
                // sigma0 + w[t - 16]
                yl = w[i - 31];
                const l2 = (s0l + yl) | 0;
                let h2 = (s0h + w[i - 32]) | 0;
                h2 = (h2 + (((s0l & yl) | ((s0l | yl) & ~l2)) >>> 31)) | 0;
                // the two sums
                xl = (l1 + l2) | 0;
                xh = (h1 + h2) | 0;
                xh = (xh + (((l1 & l2) | ((l1 | l2) & ~xl)) >>> 31)) | 0;
            }
            w[i] = xh;
            w[i + 1] = xl;

            // t1 = h + Sigma1(e) + Ch(e, f, g) + k[t] + w[t]
            // Sigma1(e): rotr 14, rotr 18, rotr 41
            const S1h =
                ((eh >>> 14) | (el << 18)) ^
                ((eh >>> 18) | (el << 14)) ^
                ((el >>> 9) | (eh << 23));
            const S1l =
                ((el >>> 14) | (eh << 18)) ^
                ((el >>> 18) | (eh << 14)) ^
                ((eh >>> 9) | (el << 23));
            // h + Sigma1
            const l1 = (hl + S1l) | 0;
            let h1 = (hh + S1h) | 0;
            h1 = (h1 + (((hl & S1l) | ((hl | S1l) & ~l1)) >>> 31)) | 0;
            // Ch + k
            const chl = gl ^ (el & (fl ^ gl));
            const kl = k[i + 1];
            const l2 = (chl + kl) | 0;
            let h2 = ((gh ^ (eh & (fh ^ gh))) + k[i]) | 0;
            h2 = (h2 + (((chl & kl) | ((chl | kl) & ~l2)) >>> 31)) | 0;
            // (h + Sigma1) + (Ch + k)
            const l3 = (l1 + l2) | 0;
            let h3 = (h1 + h2) | 0;
            h3 = (h3 + (((l1 & l2) | ((l1 | l2) & ~l3)) >>> 31)) | 0;
            // + w
            const t1l = (l3 + xl) | 0;
            let t1h = (h3 + xh) | 0;
            t1h = (t1h + (((l3 & xl) | ((l3 | xl) & ~t1l)) >>> 31)) | 0;

            // t2 = Sigma0(a) + Maj(a, b, c)
            // Sigma0(a): rotr 28, rotr 34, rotr 39
            const S0h =
                ((ah >>> 28) | (al << 4)) ^
                ((al >>> 2) | (ah << 30)) ^
                ((al >>> 7) | (ah << 25));
            const S0l =
                ((al >>> 28) | (ah << 4)) ^
                ((ah >>> 2) | (al << 30)) ^
                ((ah >>> 7) | (al << 25));
            const mjl = (al & bl) | (cl & (al | bl));
            const t2l = (S0l + mjl) | 0;
            let t2h = (S0h + ((ah & bh) | (ch & (ah | bh)))) | 0;
            t2h = (t2h + (((S0l & mjl) | ((S0l | mjl) & ~t2l)) >>> 31)) | 0;

            hh = gh;
            hl = gl;
            gh = fh;
            gl = fl;
            fh = eh;
            fl = el;
            // e = d + t1
            el = (dl + t1l) | 0;
            eh = (dh + t1h) | 0;
            eh = (eh + (((dl & t1l) | ((dl | t1l) & ~el)) >>> 31)) | 0;
            dh = ch;
            dl = cl;
            ch = bh;
            cl = bl;
            bh = ah;
            bl = al;
            // a = t1 + t2
            al = (t1l + t2l) | 0;
            ah = (t1h + t2h) | 0;
            ah = (ah + (((t1l & t2l) | ((t1l | t2l) & ~al)) >>> 31)) | 0;
        }
        add(s, 0, ah, al);
        add(s, 2, bh, bl);
        add(s, 4, ch, cl);
        add(s, 6, dh, dl);
        add(s, 8, eh, el);
        add(s, 10, fh, fl);
        add(s, 12, gh, gl);
        add(s, 14, hh, hl);
    }
}

// s[i..i+1] += (h, l)
function add(s: Int32Array, i: number, h: number, l: number) {
    const sl = s[i + 1];
    const r = (sl + l) | 0;
    let rh = (s[i] + h) | 0;
    rh = (rh + (((sl & l) | ((sl | l) & ~r)) >>> 31)) | 0;
    s[i] = rh;
    s[i + 1] = r;
}

export class Sha512 implements TsHash {
    readonly blockSize = 128;
    readonly outputLength: number;
    private readonly state: Int32Array;
    private readonly buffer: Uint8Array;
    private fill = 0;
    private bytes = 0;

    // 28: SHA-512/224, 32: SHA-512/256, 48: SHA-384, 64: SHA-512
    constructor(outputLength: 28 | 32 | 48 | 64, from?: Sha512) {
        this.outputLength = outputLength;
        if (from) {
            this.state = from.state.slice();
            this.buffer = from.buffer.slice();
            this.fill = from.fill;
            this.bytes = from.bytes;
        } else {
            this.state = IVS[outputLength].slice();
            this.buffer = new Uint8Array(128);
        }
    }

    update(data: Uint8Array) {
        const length = data.length;
        const buffer = this.buffer;
        let fill = this.fill;
        let p = 0;
        this.bytes += length;
        if (fill > 0) {
            while (fill < 128 && p < length) buffer[fill++] = data[p++];
            if (fill < 128) {
                this.fill = fill;
                return;
            }
            compress(this.state, buffer, 0, 1);
            fill = 0;
        }
        const blocks = Math.floor((length - p) / 128);
        if (blocks > 0) {
            compress(this.state, data, p, blocks);
            p += blocks * 128;
        }
        while (p < length) buffer[fill++] = data[p++];
        this.fill = fill;
    }

    digest() {
        const buffer = this.buffer;
        const state = this.state;
        let fill = this.fill;
        buffer[fill++] = 0x80;
        if (fill > 112) {
            buffer.fill(0, fill);
            compress(state, buffer, 0, 1);
            fill = 0;
        }
        // the length field is 128 bits, its upper half zero for any length
        // a double counts
        buffer.fill(0, fill, 120);
        writeBitLength(buffer, 120, this.bytes);
        compress(state, buffer, 0, 1);
        // the truncated variants keep the leading bytes, which for
        // SHA-512/224 ends in the middle of a 64-bit word
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
        return new Sha512(this.outputLength as 28 | 32 | 48 | 64, this);
    }
}
