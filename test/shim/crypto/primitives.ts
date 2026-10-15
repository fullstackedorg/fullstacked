// The TypeScript primitives of lib/crypto (hashes, HMAC, AES-CTR, ChaCha20)
// against node:crypto: lengths around the block boundaries, random
// chunkings of the same input, copies mid-stream, counters about to wrap.
// They are plain functions over Uint8Arrays, imported directly (no hooks).

import { suite, test } from "node:test";
import assert from "node:assert";
import nodeCrypto from "node:crypto";
import {
    createTsHash,
    createTsHmac,
    createAesCtr,
    createChaCha20,
    type TsHash,
    type TsStreamCipher
} from "../../../core/internal/bundle/lib/crypto/primitives/index.ts";

const HASHES = [
    "md5",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sha512-224",
    "sha512-256"
];

// deterministic data, so a failure reproduces
function prng(seed: number) {
    let x = seed >>> 0 || 1;
    return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) / 0x100000000;
    };
}
const random = prng(0x5eed);
function bytes(length: number) {
    const b = new Uint8Array(length);
    for (let i = 0; i < length; i++) b[i] = (random() * 256) | 0;
    return b;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// the same data as `pieces` views at an odd offset of a larger buffer, to
// cover the byteOffset of subarrays
function chunk(data: Uint8Array, sizes: number[]) {
    const backing = new Uint8Array(data.length + 3);
    backing.set(data, 3);
    const view = backing.subarray(3);
    const pieces: Uint8Array[] = [];
    for (let p = 0, i = 0; p < data.length; i++) {
        const size = Math.max(0, sizes[i % sizes.length]);
        pieces.push(view.subarray(p, p + size));
        p += size;
    }
    return pieces;
}

const LENGTHS = [
    ...Array.from({ length: 201 }, (_, i) => i),
    255,
    256,
    257,
    1000,
    65537
];
const CHUNKINGS = [
    [1],
    [3],
    [63],
    [64],
    [65],
    [127, 128, 129],
    [0, 7, 0, 200],
    [55, 56, 57, 111, 112, 113]
];
const BIG = bytes(70000);

function nodeDigest(algorithm: string, data: Uint8Array, key?: Uint8Array) {
    const h = key
        ? nodeCrypto.createHmac(algorithm, key)
        : nodeCrypto.createHash(algorithm);
    return h.update(data).digest("hex");
}

function checkHash(algorithm: string, create: () => TsHash, key?: Uint8Array) {
    const name = key ? `hmac-${algorithm}` : algorithm;
    test(`${name}: lengths 0..200, 255..257, 1000, 65537 in one update`, () => {
        for (const length of LENGTHS) {
            const data = BIG.subarray(0, length);
            const h = create();
            h.update(data);
            assert.strictEqual(
                hex(h.digest()),
                nodeDigest(algorithm, data, key),
                `length ${length}`
            );
        }
    });
    test(`${name}: no update at all`, () => {
        assert.strictEqual(
            hex(create().digest()),
            nodeDigest(algorithm, new Uint8Array(0), key)
        );
    });
    test(`${name}: chunked updates`, () => {
        for (const length of [0, 1, 63, 64, 65, 127, 128, 129, 1000, 5000]) {
            const data = BIG.subarray(0, length);
            const expected = nodeDigest(algorithm, data, key);
            for (const sizes of [
                ...CHUNKINGS,
                Array.from({ length: 20 }, () => (random() * 300) | 0)
            ]) {
                const h = create();
                for (const piece of chunk(data, sizes)) h.update(piece);
                assert.strictEqual(
                    hex(h.digest()),
                    expected,
                    `length ${length}, chunks ${sizes}`
                );
            }
        }
    });
    test(`${name}: copy() mid-stream`, () => {
        for (const at of [0, 1, 63, 64, 65, 100, 128, 200, 1000]) {
            const head = BIG.subarray(0, at);
            const h = create();
            h.update(head);
            const c = h.copy();
            // diverge: each continues with different data
            h.update(BIG.subarray(at, at + 300));
            c.update(BIG.subarray(5000, 5077));
            const both = new Uint8Array(at + 77);
            both.set(head);
            both.set(BIG.subarray(5000, 5077), at);
            assert.strictEqual(
                hex(h.digest()),
                nodeDigest(algorithm, BIG.subarray(0, at + 300), key),
                `original, at ${at}`
            );
            assert.strictEqual(
                hex(c.digest()),
                nodeDigest(algorithm, both, key),
                `copy, at ${at}`
            );
        }
    });
    test(`${name}: a Buffer input`, () => {
        const data = Buffer.from(BIG.buffer, BIG.byteOffset + 7, 300);
        const h = create();
        h.update(data);
        assert.strictEqual(hex(h.digest()), nodeDigest(algorithm, data, key));
    });
}

suite("crypto primitives: hashes", () => {
    for (const algorithm of HASHES) {
        const h = createTsHash(algorithm);
        const node = nodeCrypto.createHash(algorithm);
        test(`${algorithm}: block size and output length`, () => {
            assert.strictEqual(
                h.blockSize,
                algorithm.match(/384|512/) ? 128 : 64
            );
            assert.strictEqual(h.outputLength, node.digest().length);
        });
        checkHash(algorithm, () => createTsHash(algorithm));
    }
    test("unknown algorithms are null", () => {
        assert.strictEqual(createTsHash("sha3-256"), null);
        assert.strictEqual(createTsHash("SHA256"), null);
        assert.strictEqual(createTsHmac("ripemd160", new Uint8Array(4)), null);
    });
});

suite("crypto primitives: hmac", () => {
    for (const algorithm of HASHES) {
        const blockSize = createTsHash(algorithm).blockSize;
        for (const keyLength of [
            0,
            1,
            20,
            blockSize - 1,
            blockSize,
            blockSize + 1,
            300
        ]) {
            const key = bytes(keyLength);
            suite(`key of ${keyLength} bytes`, () => {
                checkHash(algorithm, () => createTsHmac(algorithm, key), key);
            });
        }
    }
});

function nodeCipher(algorithm: string, key: Uint8Array, iv: Uint8Array) {
    return nodeCrypto.createCipheriv(algorithm, key, iv);
}

function checkStream(
    algorithm: string,
    create: (key: Uint8Array, iv: Uint8Array) => TsStreamCipher,
    key: Uint8Array,
    iv: Uint8Array,
    label = ""
) {
    const name = `${algorithm}${label}`;
    test(`${name}: lengths 0..200, 1000, 65537 in one update`, () => {
        for (const length of LENGTHS) {
            const data = BIG.subarray(0, length);
            const out = create(key, iv).update(data);
            assert.ok(out instanceof Uint8Array && out !== data);
            assert.strictEqual(
                hex(out),
                hex(nodeCipher(algorithm, key, iv).update(data)),
                `length ${length}`
            );
        }
    });
    test(`${name}: chunked updates continue mid-block`, () => {
        const data = BIG.subarray(0, 5000);
        const expected = hex(nodeCipher(algorithm, key, iv).update(data));
        for (const sizes of [
            ...CHUNKINGS,
            [5, 27],
            [4, 60, 4],
            [16, 1, 15, 2, 14],
            Array.from({ length: 30 }, () => (random() * 200) | 0)
        ]) {
            const c = create(key, iv);
            const outs = chunk(data, sizes).map((piece) => c.update(piece));
            assert.strictEqual(
                hex(Buffer.concat(outs)),
                expected,
                `chunks ${sizes}`
            );
        }
    });
    test(`${name}: decrypts what it encrypts`, () => {
        const data = BIG.subarray(11, 3000);
        const encrypted = create(key, iv).update(data);
        assert.strictEqual(hex(create(key, iv).update(encrypted)), hex(data));
    });
}

suite("crypto primitives: aes-ctr", () => {
    for (const bits of [128, 192, 256]) {
        const algorithm = `aes-${bits}-ctr`;
        const key = bytes(bits / 8);
        checkStream(algorithm, createAesCtr, key, bytes(16));
        // the full 128-bit counter wraps to zero after the second block
        checkStream(
            algorithm,
            createAesCtr,
            key,
            Buffer.from("ff".repeat(15) + "fe", "hex"),
            " (iv ff..fe)"
        );
        // a carry from the low 32 bits into the next word
        checkStream(
            algorithm,
            createAesCtr,
            key,
            Buffer.from("0123456789abcdef00000000fffffffd", "hex"),
            " (iv with a 32-bit carry)"
        );
    }
    test("FIPS 197 C.1: AES-128 on one block (a CTR of that block)", () => {
        // the keystream of the first block is AES(key, iv)
        const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
        const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
        assert.strictEqual(
            hex(createAesCtr(key, iv).update(new Uint8Array(16))),
            "69c4e0d86a7b0430d8cdb78070b4c55a"
        );
    });
});

suite("crypto primitives: chacha20", () => {
    const key = bytes(32);
    checkStream("chacha20", createChaCha20, key, bytes(16));
    checkStream(
        "chacha20",
        createChaCha20,
        key,
        Buffer.from("07000000" + "000000090000004a00000000", "hex"),
        " (initial counter 7)"
    );
    // the 32-bit block counter wraps: OpenSSL carries into the nonce
    checkStream(
        "chacha20",
        createChaCha20,
        key,
        Buffer.from("fdffffff" + "ffffffff0102030405060708", "hex"),
        " (counter about to wrap)"
    );
    test("RFC 8439 2.4.2: encryption with initial counter 1", () => {
        const key = Buffer.from(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            "hex"
        );
        const iv = Buffer.from("01000000" + "000000000000004a00000000", "hex");
        const plaintext = Buffer.from(
            "Ladies and Gentlemen of the class of '99: If I could offer you " +
                "only one tip for the future, sunscreen would be it."
        );
        const expected =
            "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b" +
            "f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8" +
            "07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736" +
            "5af90bbf74a35be6b40b8eedf2785e42874d";
        assert.strictEqual(
            hex(createChaCha20(key, iv).update(plaintext)),
            expected
        );
        assert.strictEqual(
            hex(nodeCipher("chacha20", key, iv).update(plaintext)),
            expected
        );
    });
});
