// sign/verify one-shots and the Sign/Verify streams
// (lib/internal/crypto/sig.js). The core hashes and signs in one call; the
// streams keep their input until sign()/verify().

import { Writable } from "stream";
import { Sign as SignFn, Verify as VerifyFn } from "../@types/crypto.ts";
import { call, callAsync, settle } from "./core.ts";
import { HASH_SIZES, hashName } from "./names.ts";
import { CONSUME_PRIVATE, CONSUME_PUBLIC, prepareKey } from "./keys.ts";
import { concat, encode, toBuffer, toBytes } from "./util.ts";
import {
    fail,
    invalidArgType,
    invalidArgValue,
    validateCallback,
    validateString
} from "./errors.ts";

// the core call's arguments: digest, data, the key's DER, the signature
// when verifying, and the padding, saltLength and dsaEncoding of a
// { key, ... } argument
function args(
    algorithm: string,
    data: Uint8Array,
    key: any,
    signature?: Uint8Array
) {
    if (!key) throw fail("ERR_CRYPTO_SIGN_KEY_REQUIRED");
    const ctx = signature ? CONSUME_PUBLIC : CONSUME_PRIVATE;
    const { der } = prepareKey(key, ctx);
    const o: Record<string, unknown> = {};
    if (typeof key === "object") {
        for (const name of ["padding", "saltLength"]) {
            const value = key[name];
            if (value !== undefined && value !== value >> 0) {
                throw invalidArgValue("options." + name, value, "is invalid");
            }
            o[name] = value;
        }
        const { dsaEncoding = "der" } = key;
        if (!/^(der|ieee-p1363)$/.test(dsaEncoding)) {
            throw invalidArgValue(
                "options.dsaEncoding",
                dsaEncoding,
                "is invalid"
            );
        }
        o.dsaEncoding = dsaEncoding;
    }
    return signature
        ? [algorithm, data, der, signature, o]
        : [algorithm, data, der, o];
}

// the digest the core gets: none for the key's default; an unknown one is
// refused here so that the callback forms throw it synchronously, as Node
function digest(algorithm: any, callback: unknown, stream?: boolean) {
    if (callback !== undefined) validateCallback(callback);
    if (algorithm == null && !stream) return undefined;
    validateString(algorithm, "algorithm");
    const name = hashName(algorithm);
    if (!HASH_SIZES[name]) {
        throw fail("ERR_CRYPTO_INVALID_DIGEST", stream ? "" : ": " + algorithm);
    }
    return name;
}

// the signature: a view; Verify.verify() also takes a string
function signature(value: any, encoding?: string, string = true) {
    if (!(string && typeof value === "string") && !ArrayBuffer.isView(value)) {
        throw invalidArgType(
            "signature",
            "an instance of Buffer, TypedArray, or DataView",
            value
        );
    }
    return toBytes(value, "signature", encoding);
}

export function sign(algorithm: any, data: any, key: any, callback?: any) {
    const a = args(digest(algorithm, callback), toBytes(data, "data"), key);
    if (callback === undefined) return toBuffer(call(SignFn, ...a));
    settle(callAsync(SignFn, ...a), callback, toBuffer);
}

export function verify(
    algorithm: any,
    data: any,
    key: any,
    sig: any,
    callback?: any
) {
    const a = args(
        digest(algorithm, callback),
        toBytes(data, "data"),
        key,
        signature(sig, undefined, false)
    );
    if (callback === undefined) return call(VerifyFn, ...a) as boolean;
    settle(callAsync(VerifyFn, ...a), callback);
}

const kAlgorithm = Symbol("kAlgorithm");
const kChunks = Symbol("kChunks");

function Signer(this: any, algorithm: string, options?: any) {
    this[kAlgorithm] = digest(algorithm, undefined, true);
    this[kChunks] = [];
    (Writable as any).call(this, options);
}
Object.setPrototypeOf(Signer.prototype, Writable.prototype);

const notInitialised = () =>
    fail("ERR_CRYPTO_INVALID_STATE", ": not initialised");

Signer.prototype.update = function (this: any, data: any, encoding?: string) {
    if (!this[kChunks]) throw notInitialised();
    this[kChunks].push(toBytes(data, "data", encoding).slice());
    return this;
};

Signer.prototype._write = function (
    this: any,
    chunk: any,
    encoding: string,
    callback: (error?: Error) => void
) {
    try {
        this.update(chunk, encoding);
    } catch (e) {
        return callback(e as Error);
    }
    callback();
};

// the input so far, once: sign()/verify() spend the object as in Node
Signer.prototype._args = function (this: any, key: any, sig?: Uint8Array) {
    const a = args(this[kAlgorithm], null, key, sig);
    if (!this[kChunks]) throw notInitialised();
    a[1] = concat(this[kChunks]);
    this[kChunks] = null;
    return a;
};

export function Sign(this: any, algorithm: string, options?: any): any {
    if (!(this instanceof (Sign as any))) {
        return new (Sign as any)(algorithm, options);
    }
    Signer.call(this, algorithm, options);
}
Object.setPrototypeOf(Sign.prototype, Signer.prototype);

Sign.prototype.sign = function (this: any, key: any, encoding?: string) {
    return encode(call(SignFn, ...this._args(key)), encoding);
};

export function Verify(this: any, algorithm: string, options?: any): any {
    if (!(this instanceof (Verify as any))) {
        return new (Verify as any)(algorithm, options);
    }
    Signer.call(this, algorithm, options);
}
Object.setPrototypeOf(Verify.prototype, Signer.prototype);

Verify.prototype.verify = function (
    this: any,
    key: any,
    sig: any,
    sigEncoding?: string
) {
    return call(VerifyFn, ...this._args(key, signature(sig, sigEncoding)));
};

export const createSign = (algorithm: string, options?: any) =>
    new (Sign as any)(algorithm, options);

export const createVerify = (algorithm: string, options?: any) =>
    new (Verify as any)(algorithm, options);
