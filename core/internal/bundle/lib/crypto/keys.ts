// KeyObject (lib/internal/crypto/keys.js) and key generation. An
// asymmetric key is parsed once by the core and kept as DER (SPKI or
// PKCS#8) with its type and details; every use hands the DER back. PEM,
// DER and JWK keys passed directly to sign, verify, publicEncrypt... go
// through a small cache, so a key used over and over is parsed once.

import { Buffer } from "buffer";
import { KeyExport, KeyGenerate, KeyParse } from "../@types/crypto.ts";
import { call, callAsync, settle } from "./core.ts";
import { cipherInfo, curveName, getCurves } from "./names.ts";
import { isStringOrBytes, toBuffer, toBytes } from "./util.ts";
import { fill } from "./random.ts";
import {
    BYTES,
    STRING_OR_BYTES,
    fail,
    invalidArgType,
    invalidArgValue,
    invalidKeyObjectType,
    validateCallback,
    validateInt32,
    validateInteger,
    validateObject,
    validateString,
    validateUint32
} from "./errors.ts";

export type KeyData = {
    type: string;
    asymmetricKeyType: string;
    // null until asked for, for generated keys
    details: Record<string, unknown> | null;
    der: Uint8Array;
};

const kType = Symbol("kType");
// the bytes of a secret key, the KeyData of an asymmetric one
export const kKey = Symbol("kKey");

export class KeyObject {
    declare [kType]: string;
    declare [kKey]: any;

    constructor(type: string, key: unknown) {
        if (!/^(secret|public|private)$/.test(type)) {
            throw invalidArgValue("type", type, "is invalid");
        }
        this[kType] = type;
        this[kKey] = key;
    }

    get type() {
        return this[kType];
    }

    equals(otherKeyObject: KeyObject) {
        if (!(otherKeyObject instanceof KeyObject)) {
            throw invalidArgType(
                "otherKeyObject",
                "an instance of KeyObject",
                otherKeyObject
            );
        }
        const [a, b] = [this, otherKeyObject].map(
            (k) => k[kKey].der ?? k[kKey]
        );
        return (
            otherKeyObject.type === this.type &&
            a.length === b.length &&
            a.every((x: number, i: number) => x === b[i])
        );
    }
}

class SecretKeyObject extends KeyObject {
    constructor(bytes: Uint8Array) {
        super("secret", bytes);
    }

    get symmetricKeySize() {
        return this[kKey].length;
    }

    export(options?: any) {
        if (options !== undefined) {
            validateObject(options, "options");
            const { format } = options;
            if (format === "jwk") {
                const k = toBuffer(this[kKey]).toString("base64url");
                return { kty: "oct", k };
            }
            if (format !== undefined && format !== "buffer") {
                throw invalidArgValue(
                    "options.format",
                    format,
                    "must be one of: undefined, 'buffer', 'jwk'"
                );
            }
        }
        return Buffer.from(this[kKey] as Uint8Array);
    }
}

// the public and the private keys
class AsymmetricKeyObject extends KeyObject {
    constructor(key: KeyData) {
        super(key.type, key);
    }

    get asymmetricKeyType() {
        return this[kKey].asymmetricKeyType;
    }

    get asymmetricKeyDetails() {
        const key: KeyData = this[kKey];
        const pub = key.type === "public";
        const type = pub ? "spki" : "pkcs8";
        key.details ??= details(
            call(KeyParse, key.der, "der", type, undefined, pub).details
        );
        return key.details;
    }

    export(options?: any) {
        const key: KeyData = this[kKey];
        const { asymmetricKeyType, type } = key;
        return exportKey(
            key,
            options?.format === "jwk"
                ? options
                : keyEncoding(options, asymmetricKeyType, type === "public")
        );
    }
}

type Encoding = {
    format: string;
    type?: string;
    cipher?: string;
    passphrase?: Uint8Array;
};

function exportKey(key: KeyData, enc: Encoding) {
    const { format, type, cipher, passphrase } = enc;
    const out = call(
        KeyExport,
        key.der,
        key.type,
        format,
        type,
        cipher == null ? undefined : (cipherInfo(cipher)?.name ?? cipher),
        passphrase
    );
    return out instanceof Uint8Array ? toBuffer(out) : out;
}

// Node's parseKeyEncoding: format, type, cipher and passphrase of a key
// input (keyType undefined) or of an export to a keyType key
export function keyEncoding(
    enc: any,
    keyType: string | undefined,
    isPublic: boolean | undefined,
    objName?: string
): Encoding {
    validateObject(enc, "options");
    const invalid = (name: string, value: unknown) =>
        invalidArgValue(
            `options.${objName ? objName + "." : ""}${name}`,
            value,
            "is invalid"
        );
    const isInput = keyType === undefined;
    const format = enc.format ?? (isInput ? "pem" : undefined);
    if (!/^(pem|der|jwk)$/.test(format)) throw invalid("format", enc.format);

    const { type, encoding } = enc;
    if (
        type !== undefined ||
        ((!isInput || format === "der") && format !== "jwk")
    ) {
        if (!(
            type === "pkcs1" ||
            (type === "spki" && isPublic !== false) ||
            ((type === "pkcs8" || type === "sec1") && isPublic !== true)
        )) {
            throw invalid("type", type);
        }
        const only = type === "pkcs1" ? "rsa" : type === "sec1" ? "ec" : null;
        if (only && !isInput && keyType !== only) {
            throw fail(
                "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
                `${type} can only be used for ${only.toUpperCase()} keys.`
            );
        }
    }

    let { cipher, passphrase } = enc;
    if (isPublic) {
        cipher = passphrase = undefined;
    } else {
        if (!isInput) {
            if (
                cipher == null
                    ? passphrase !== undefined
                    : typeof cipher !== "string"
            ) {
                throw invalid("cipher", cipher);
            }
            if (cipher != null && format === "der" && type !== "pkcs8") {
                throw fail(
                    "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
                    type + " does not support encryption."
                );
            }
        }
        if (
            (isInput ? passphrase !== undefined : cipher != null) &&
            !isStringOrBytes(passphrase)
        ) {
            throw invalid("passphrase", passphrase);
        }
    }
    return {
        format,
        type,
        cipher,
        passphrase:
            passphrase === undefined
                ? undefined
                : toBytes(passphrase, "key.passphrase", encoding)
    };
}

// the details as Node gives them, the RSA exponent as a bigint
function details(d: any) {
    if (d?.publicExponent) d.publicExponent = BigInt(d.publicExponent);
    return d;
}

// what a key argument is for (Node's kConsumePublic...)
export const CONSUME_PUBLIC = 0;
export const CONSUME_PRIVATE = 1;
export const CREATE_PUBLIC = 2;
export const CREATE_PRIVATE = 3;

const needsPrivate = (ctx: number) =>
    ctx === CONSUME_PRIVATE || ctx === CREATE_PRIVATE;

const keyTypes = (ctx: number) =>
    ctx === CREATE_PRIVATE
        ? STRING_OR_BYTES
        : "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";

const cache = new Map<string, KeyData>();

function parse(
    key: any,
    format: string,
    type: string | undefined,
    passphrase: Uint8Array | undefined,
    ctx: number
): KeyData {
    const wantPublic = !needsPrivate(ctx);
    // keys with a passphrase and JWK objects are not kept; bytes are keyed
    // by their latin1 string
    let id: string = null;
    if (!passphrase && format !== "jwk") {
        const input =
            typeof key === "string" ? key : toBuffer(key).toString("latin1");
        id = `${wantPublic} ${format} ${type}:${input}`;
    }
    let parsed = id && cache.get(id);
    if (parsed) {
        cache.delete(id);
    } else {
        parsed = call(KeyParse, key, format, type, passphrase, wantPublic);
        parsed.details = details(parsed.details);
        parsed.der = Buffer.from(parsed.der as any, "base64");
    }
    if (id) {
        cache.set(id, parsed);
        if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    // a public key where a private one is expected fails to decode in Node
    if (!wantPublic && parsed.type !== "private") {
        throw fail("ERR_OSSL_UNSUPPORTED");
    }
    return parsed;
}

function keyObjectData(key: KeyObject, ctx: number): KeyData {
    if (ctx === CREATE_PRIVATE) throw invalidArgType("key", keyTypes(ctx), key);
    if (key.type !== "private") {
        if (ctx === CONSUME_PRIVATE || ctx === CREATE_PUBLIC) {
            throw invalidKeyObjectType(key.type, "private");
        }
        if (key.type !== "public") {
            throw invalidKeyObjectType(key.type, "private or public");
        }
    }
    return key[kKey];
}

// Node's prepareAsymmetricKey: a KeyObject, a PEM string or buffer, or
// { key, format, type, passphrase, encoding } -> the key's data
export function prepareKey(key: any, ctx: number): KeyData {
    if (key instanceof KeyObject) return keyObjectData(key, ctx);
    if (isStringOrBytes(key)) {
        if (typeof key !== "string") key = toBytes(key, "key");
        return parse(key, "pem", undefined, undefined, ctx);
    }
    if (key && typeof key === "object") {
        const { key: data, encoding, format } = key;
        if (data instanceof KeyObject) return keyObjectData(data, ctx);
        if (format === "jwk") {
            validateObject(data, "key.key");
            return parse(data, "jwk", undefined, undefined, ctx);
        }
        if (!isStringOrBytes(data)) {
            throw invalidArgType("key.key", keyTypes(ctx), data);
        }
        const enc = keyEncoding(
            key,
            undefined,
            needsPrivate(ctx) ? false : undefined
        );
        return parse(
            enc.format === "pem" && typeof data === "string"
                ? data
                : toBytes(data, "key", encoding),
            enc.format,
            enc.type,
            enc.passphrase,
            ctx
        );
    }
    throw invalidArgType("key", keyTypes(ctx), key);
}

// Node's prepareSecretKey: the bytes of a symmetric key
export function secretBytes(key: any, encoding?: string): Uint8Array {
    if (!(key instanceof KeyObject)) {
        return toBytes(key, "key", encoding, keyTypes(CONSUME_PUBLIC));
    }
    if (key.type !== "secret") throw invalidKeyObjectType(key.type, "secret");
    return key[kKey];
}

export function createPublicKey(key: any) {
    let data = prepareKey(key, CREATE_PUBLIC);
    if (data.type === "private") {
        data = parse(data.der, "der", "pkcs8", undefined, CREATE_PUBLIC);
    }
    return new AsymmetricKeyObject(data);
}

export const createPrivateKey = (key: any) =>
    new AsymmetricKeyObject(prepareKey(key, CREATE_PRIVATE));

export const createSecretKey = (key: any, encoding?: string) =>
    new SecretKeyObject(toBytes(key, "key", encoding, BYTES).slice());

// --- generation ---

const OKP = /^(ed|x)(25519|448)$/;

// Node's checks, so that generateKeyPair throws them synchronously
function keyGenArgs(type: string, options: any) {
    validateString(type, "type");
    const encodings = ["publicKeyEncoding", "privateKeyEncoding"].map(
        (name, i) => {
            const enc = options?.[name];
            if (enc == null) return null;
            if (typeof enc !== "object") {
                throw invalidArgValue("options." + name, enc, "is invalid");
            }
            return keyEncoding(enc, type, !i, name);
        }
    );
    if (options !== undefined || /^(rsa|rsa-pss|ec)$/.test(type)) {
        validateObject(options, "options");
    }
    const o: Record<string, any> = {};
    if (type === "rsa" || type === "rsa-pss") {
        validateUint32(options.modulusLength, "options.modulusLength");
        if (options.publicExponent != null) {
            validateUint32(options.publicExponent, "options.publicExponent");
        }
        o.modulusLength = options.modulusLength;
        o.publicExponent = options.publicExponent;
        if (type === "rsa-pss") {
            if (options.saltLength !== undefined) {
                validateInt32(options.saltLength, "options.saltLength", 0);
            }
            o.saltLength = options.saltLength;
            // hash and mgf1Hash are Node's deprecated names
            for (const name of [
                "hashAlgorithm",
                "mgf1HashAlgorithm",
                "hash",
                "mgf1Hash"
            ]) {
                if (options[name] !== undefined) {
                    validateString(options[name], "options." + name);
                }
                o[name] = options[name];
            }
        }
    } else if (type === "ec") {
        validateString(options.namedCurve, "options.namedCurve");
        o.namedCurve = curveName(options.namedCurve);
        if (!getCurves().includes(o.namedCurve)) {
            throw fail("ERR_CRYPTO_INVALID_CURVE");
        }
    } else if (type === "dsa" || type === "dh") {
        throw fail("ERR_OSSL_UNSUPPORTED");
    } else if (!OKP.test(type)) {
        throw invalidArgValue("type", type, "must be a supported key type");
    }
    return { args: [type, o], encodings };
}

function keyPair(type: string, encodings: Encoding[], r: any) {
    const [publicKey, privateKey] = ["public", "private"].map((kind, i) => {
        const data: KeyData = {
            type: kind,
            asymmetricKeyType: type,
            details: null,
            der: Buffer.from(r[kind + "Key"], "base64")
        };
        return encodings[i]
            ? exportKey(data, encodings[i])
            : new AsymmetricKeyObject(data);
    });
    return { publicKey, privateKey };
}

export function generateKeyPairSync(type: string, options?: any) {
    const { args, encodings } = keyGenArgs(type, options);
    return keyPair(type, encodings, call(KeyGenerate, ...args));
}

export function generateKeyPair(type: string, options: any, callback?: any) {
    if (typeof options === "function") {
        callback = options;
        options = undefined;
    }
    validateCallback(callback);
    const { args, encodings } = keyGenArgs(type, options);
    settle(
        callAsync(KeyGenerate, ...args).then((r) =>
            keyPair(type, encodings, r)
        ),
        (e, pair) =>
            e ? callback(e) : callback(null, pair.publicKey, pair.privateKey)
    );
}

(generateKeyPair as any)[Symbol.for("nodejs.util.promisify.custom")] = (
    type: string,
    options?: any
) => {
    const { args, encodings } = keyGenArgs(type, options);
    return callAsync(KeyGenerate, ...args).then((r) =>
        keyPair(type, encodings, r)
    );
};

// a random key of options.length bits (hmac: 8 to 2^31-1, aes: 128, 192
// or 256)
function randomKey(type: string, options: any) {
    validateString(type, "type");
    validateObject(options, "options");
    const { length } = options;
    if (type === "hmac") {
        validateInteger(length, "options.length", 8, 2 ** 31 - 1);
    } else if (type !== "aes") {
        throw invalidArgValue("type", type, "must be a supported key type");
    } else if (length !== 128 && length !== 192 && length !== 256) {
        throw invalidArgValue(
            "options.length",
            length,
            "must be one of: 128, 192, 256"
        );
    }
    return new SecretKeyObject(fill(new Uint8Array(length >>> 3)));
}

export const generateKeySync = randomKey;

export function generateKey(type: string, options: any, callback?: any) {
    validateCallback(callback);
    const key = randomKey(type, options);
    queueMicrotask(() => callback(null, key));
}
