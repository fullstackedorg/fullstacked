// The crypto primitives that run in the webview rather than in the core
// (improvements/shim/plan.md 5.1): MD5, SHA-1, SHA-2, HMAC over them, and the two stream
// ciphers AES-CTR and ChaCha20. A bridge call costs more than hashing or
// encrypting a few kilobytes here; lib/crypto picks between these and the
// core by input size.
//
// Inputs are Uint8Arrays (views with a byteOffset and Buffers included),
// outputs fresh Uint8Arrays the caller wraps as it needs. The factories do
// not validate key and IV lengths: lib/crypto does, with Node's errors.

import { Md5 } from "./md5.ts";
import { Sha1 } from "./sha1.ts";
import { Sha256 } from "./sha256.ts";
import { Sha512 } from "./sha512.ts";
import { Hmac } from "./hmac.ts";
import { AesCtr } from "./aes.ts";
import { ChaCha20 } from "./chacha20.ts";

export interface TsHash {
    readonly blockSize: number;
    readonly outputLength: number;
    // any length, any number of calls
    update(data: Uint8Array): void;
    // once; the instance is spent after it
    digest(): Uint8Array;
    // an independent copy of the current state
    copy(): TsHash;
}

// XORs the keystream into a copy of data; the position in the keystream is
// kept across calls at byte granularity
export interface TsStreamCipher {
    update(data: Uint8Array): Uint8Array;
}

// canonical lowercase names, as lib/crypto normalizes them; null for the
// algorithms left to the core
export function createTsHash(algorithm: string): TsHash | null {
    switch (algorithm) {
        case "md5":
            return new Md5();
        case "sha1":
            return new Sha1();
        case "sha224":
            return new Sha256(28);
        case "sha256":
            return new Sha256(32);
        case "sha384":
            return new Sha512(48);
        case "sha512":
            return new Sha512(64);
        case "sha512-224":
            return new Sha512(28);
        case "sha512-256":
            return new Sha512(32);
    }
    return null;
}

export function createTsHmac(
    algorithm: string,
    key: Uint8Array
): TsHash | null {
    const inner = createTsHash(algorithm);
    if (inner === null) return null;
    // keys longer than a block are replaced by their hash (RFC 2104 2)
    if (key.length > inner.blockSize) {
        const h = createTsHash(algorithm);
        h.update(key);
        key = h.digest();
    }
    return new Hmac(inner, createTsHash(algorithm), key);
}

// key of 16, 24 or 32 bytes (AES-128/192/256), iv of 16
export function createAesCtr(key: Uint8Array, iv: Uint8Array): TsStreamCipher {
    return new AesCtr(key, iv);
}

// key of 32 bytes, iv of 16 (counter then nonce)
export function createChaCha20(
    key: Uint8Array,
    iv: Uint8Array
): TsStreamCipher {
    return new ChaCha20(key, iv);
}
