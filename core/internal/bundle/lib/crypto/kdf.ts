// pbkdf2, scrypt and hkdf: one core call each, async for the callback
// forms. Everything Node rejects synchronously is checked here first, so
// that the callback forms throw the same errors at the same time.

import { Hkdf, Pbkdf2, Scrypt } from "../@types/crypto.ts";
import { call, callAsync, settle } from "./core.ts";
import { HASH_SIZES, hashName } from "./names.ts";
import { KeyObject, secretBytes } from "./keys.ts";
import { toBuffer, toBytes } from "./util.ts";
import {
    STRING_OR_BYTES,
    ERR_OUT_OF_RANGE,
    fail,
    validateCallback,
    validateInt32,
    validateInteger,
    validateString,
    validateUint32
} from "./errors.ts";

function digestName(digest: string) {
    const name = hashName(digest);
    if (!HASH_SIZES[name])
        throw fail("ERR_CRYPTO_INVALID_DIGEST", ": " + digest);
    return name;
}

function pbkdf2Args(
    password: any,
    salt: any,
    iterations: any,
    keylen: any,
    digest: any
) {
    validateString(digest, "digest");
    const args = [toBytes(password, "password"), toBytes(salt, "salt")];
    validateInt32(iterations, "iterations", 1);
    validateInt32(keylen, "keylen", 0);
    return [...args, iterations, keylen, digestName(digest)];
}

export const pbkdf2Sync = (
    password: any,
    salt: any,
    iterations: number,
    keylen: number,
    digest: string
) =>
    toBuffer(
        call(Pbkdf2, ...pbkdf2Args(password, salt, iterations, keylen, digest))
    );

export function pbkdf2(
    password: any,
    salt: any,
    iterations: number,
    keylen: number,
    digest: any,
    callback?: any
) {
    if (typeof digest === "function") {
        callback = digest;
        digest = undefined;
    }
    const args = pbkdf2Args(password, salt, iterations, keylen, digest);
    validateCallback(callback);
    settle(callAsync(Pbkdf2, ...args), callback, toBuffer);
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 << 20 };

function scryptArgs(password: any, salt: any, keylen: any, options: any) {
    const args = [toBytes(password, "password"), toBytes(salt, "salt")];
    validateInt32(keylen, "keylen", 0);
    let { N, r, p, maxmem } = SCRYPT;
    if (options) {
        // each parameter has a long name too, they cannot be combined
        const pick = (name: string, alias: string, fallback: number) => {
            let value = options[name];
            if (value !== undefined) validateUint32(value, name);
            if (options[alias] !== undefined) {
                if (value !== undefined) {
                    throw fail(
                        "ERR_INCOMPATIBLE_OPTION_PAIR",
                        `${name}, ${alias}`
                    );
                }
                value = options[alias];
                validateUint32(value, alias);
            }
            return value || fallback;
        };
        N = pick("N", "cost", N);
        r = pick("r", "blockSize", r);
        p = pick("p", "parallelization", p);
        if (options.maxmem !== undefined) {
            validateInteger(options.maxmem, "maxmem", 0);
            maxmem = options.maxmem || maxmem;
        }
    }
    // OpenSSL's checks, memory included
    if (
        N < 2 ||
        (N & (N - 1)) !== 0 ||
        p > (2 ** 30 - 1) / r ||
        (16 * r <= 63 && N >= 2 ** (16 * r)) ||
        128 * r * p + 128 * r * (N + 2) > maxmem
    ) {
        throw fail("ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
    }
    return [...args, keylen, { N, r, p, maxmem }];
}

export const scryptSync = (
    password: any,
    salt: any,
    keylen: number,
    options?: any
) => toBuffer(call(Scrypt, ...scryptArgs(password, salt, keylen, options)));

export function scrypt(
    password: any,
    salt: any,
    keylen: number,
    options: any,
    callback?: any
) {
    if (typeof options === "function") {
        callback = options;
        options = undefined;
    }
    const args = scryptArgs(password, salt, keylen, options);
    validateCallback(callback);
    settle(callAsync(Scrypt, ...args), callback, toBuffer);
}

function hkdfArgs(digest: any, ikm: any, salt: any, info: any, keylen: any) {
    validateString(digest, "digest");
    const key =
        ikm instanceof KeyObject
            ? secretBytes(ikm)
            : toBytes(ikm, "ikm", undefined, STRING_OR_BYTES);
    const saltBytes = toBytes(salt, "salt");
    const infoBytes = toBytes(info, "info");
    validateInteger(keylen, "length", 0);
    if (infoBytes.length > 1024) {
        throw ERR_OUT_OF_RANGE(
            "info",
            "must not contain more than 1024 bytes",
            infoBytes.length
        );
    }
    const name = digestName(digest);
    if (keylen > 255 * HASH_SIZES[name]) {
        throw fail("ERR_CRYPTO_INVALID_KEYLEN");
    }
    return [name, key, saltBytes, infoBytes, keylen];
}

// hkdf gives an ArrayBuffer
const arrayBuffer = (bytes: Uint8Array) =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export const hkdfSync = (
    digest: string,
    ikm: any,
    salt: any,
    info: any,
    keylen: number
) => arrayBuffer(call(Hkdf, ...hkdfArgs(digest, ikm, salt, info, keylen)));

export function hkdf(
    digest: string,
    ikm: any,
    salt: any,
    info: any,
    keylen: number,
    callback: any
) {
    const args = hkdfArgs(digest, ikm, salt, info, keylen);
    validateCallback(callback);
    settle(callAsync(Hkdf, ...args), callback, arrayBuffer);
}
