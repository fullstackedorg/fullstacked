// Key agreement (lib/internal/crypto/diffiehellman.js): diffieHellman()
// over KeyObjects, the classic DiffieHellman/DiffieHellmanGroup with raw
// values, and ECDH. Each operation is one core call; the keys stay in JS.

import { Buffer } from "buffer";
import {
    DhCompute,
    DhGenerate,
    DhGroup,
    DiffieHellman as DiffieHellmanFn,
    EcdhCompute,
    EcdhConvertKey,
    EcdhGenerate
} from "../@types/crypto.ts";
import { call, callAsync, settle } from "./core.ts";
import { KeyObject, kKey } from "./keys.ts";
import { getCurves } from "./names.ts";
import { encode, EMPTY, isBytes, toBuffer, toBytes } from "./util.ts";
import {
    fail,
    invalidArgType,
    invalidArgValue,
    invalidKeyObjectType,
    validateInt32,
    validateObject,
    validateString
} from "./errors.ts";

// the key types diffieHellman() takes (Node's also has dh, which the core
// does not)
const DH_KEY_TYPES = ["ec", "x25519", "x448"];

export function diffieHellman(options: any, callback?: any) {
    validateObject(options, "options");
    const { privateKey, publicKey } = options;
    for (const [name, key] of [
        ["privateKey", privateKey],
        ["publicKey", publicKey]
    ]) {
        if (!(key instanceof KeyObject)) {
            throw invalidArgValue("options." + name, key, "is invalid");
        }
    }
    if (privateKey.type !== "private") {
        throw invalidKeyObjectType(privateKey.type, "private");
    }
    if (publicKey.type === "secret") {
        throw invalidKeyObjectType("secret", "private or public");
    }
    const a = privateKey[kKey];
    const b = publicKey[kKey];
    const type = a.asymmetricKeyType;
    if (type !== b.asymmetricKeyType || !DH_KEY_TYPES.includes(type)) {
        throw fail(
            "ERR_CRYPTO_INCOMPATIBLE_KEY",
            `${type} and ${b.asymmetricKeyType}`
        );
    }
    if (callback === undefined) {
        return toBuffer(call(DiffieHellmanFn, a.der, b.der));
    }
    settle(callAsync(DiffieHellmanFn, a.der, b.der), callback, toBuffer);
}

// DhGenerate and EcdhGenerate: 4 bytes of public key length, the public
// key, the private key
function setKeys(s: any, r: Uint8Array) {
    const n = 4 + ((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]);
    s.publicKey = r.subarray(4, n);
    s.privateKey = r.subarray(n);
}

const kDh = Symbol("kDh");

const GENERATOR =
    "one of type number or string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView";

function getKey(self: any, kind: string, encoding?: string) {
    const key = self[kDh][kind + "Key"];
    if (!key) {
        throw fail(
            "ERR_CRYPTO_INVALID_STATE",
            ` - no ${kind} key, did you forget to generate one?`
        );
    }
    return encode(key, encoding);
}

const dhProto = {
    generateKeys(this: any, encoding?: string) {
        const s = this[kDh];
        setKeys(s, call(DhGenerate, s.prime, s.generator, s.privateKey));
        return encode(s.publicKey, encoding);
    },
    computeSecret(this: any, key: any, inEnc?: string, outEnc?: string) {
        const s = this[kDh];
        const other = toBytes(key, "key", inEnc);
        // Node gives an empty secret without a private key
        return encode(
            s.privateKey
                ? call(DhCompute, s.prime, s.privateKey, other)
                : EMPTY,
            outEnc
        );
    },
    getPrime(this: any, encoding?: string) {
        return encode(this[kDh].prime, encoding);
    },
    getGenerator(this: any, encoding?: string) {
        return encode(this[kDh].generator, encoding);
    },
    getPublicKey(this: any, encoding?: string) {
        return getKey(this, "public", encoding);
    },
    getPrivateKey(this: any, encoding?: string) {
        return getKey(this, "private", encoding);
    }
};

// a generator given as a number, as big-endian bytes; a negative one gives
// 0, which initDh refuses like OpenSSL
function generatorBytes(generator: number) {
    const bytes: number[] = [];
    let n = Math.max(generator, 0);
    do {
        bytes.unshift(n & 255);
        n = Math.floor(n / 256);
    } while (n > 0);
    return new Uint8Array(bytes);
}

// verifyError is 0: OpenSSL's DH_check (primality of p, suitability of g)
// is not run on caller-supplied primes
function initDh(self: any, prime: Uint8Array, generator: Uint8Array) {
    let value = 0;
    for (const byte of generator) value = value * 256 + byte;
    if (value < 2) throw fail("ERR_OSSL_DH_BAD_GENERATOR");
    self[kDh] = { prime, generator };
    Object.defineProperty(self, "verifyError", { enumerable: true, value: 0 });
}

export function DiffieHellman(
    this: any,
    sizeOrKey: any,
    keyEncoding?: any,
    generator?: any,
    genEncoding?: any
): any {
    if (!(this instanceof (DiffieHellman as any))) {
        return new (DiffieHellman as any)(
            sizeOrKey,
            keyEncoding,
            generator,
            genEncoding
        );
    }
    if (typeof sizeOrKey !== "string" && !isBytes(sizeOrKey)) {
        if (typeof sizeOrKey !== "number") {
            throw invalidArgType("sizeOrKey", GENERATOR, sizeOrKey);
        }
        validateInt32(sizeOrKey, "sizeOrKey");
        // generating a safe prime is minutes of work on a phone
        throw fail("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "primeLength");
    }
    if (
        keyEncoding &&
        !Buffer.isEncoding(keyEncoding) &&
        keyEncoding !== "buffer"
    ) {
        genEncoding = generator;
        generator = keyEncoding;
        keyEncoding = undefined;
    }
    let g: Uint8Array;
    if (!generator) {
        g = new Uint8Array([2]);
    } else if (typeof generator === "number") {
        validateInt32(generator, "generator");
        g = generatorBytes(generator);
    } else if (typeof generator === "string" || isBytes(generator)) {
        g = toBytes(generator, "generator", genEncoding).slice();
    } else {
        throw invalidArgType("generator", GENERATOR, generator);
    }
    initDh(this, toBytes(sizeOrKey, "sizeOrKey", keyEncoding).slice(), g);
}

Object.assign(DiffieHellman.prototype, dhProto, {
    setPublicKey(this: any, key: any, encoding?: string) {
        this[kDh].publicKey = toBytes(key, "key", encoding).slice();
        return this;
    },
    setPrivateKey(this: any, key: any, encoding?: string) {
        this[kDh].privateKey = toBytes(key, "key", encoding).slice();
        return this;
    }
});

// the primes live in the core, fetched once per group
const DH_GROUPS = [
    "modp1",
    "modp2",
    "modp5",
    "modp14",
    "modp15",
    "modp16",
    "modp17",
    "modp18"
];
const groupPrimes = new Map<string, Uint8Array>();

export function DiffieHellmanGroup(this: any, name: string): any {
    if (!(this instanceof (DiffieHellmanGroup as any))) {
        return new (DiffieHellmanGroup as any)(name);
    }
    validateString(name, "name");
    if (!DH_GROUPS.includes(name)) {
        throw fail("ERR_CRYPTO_UNKNOWN_DH_GROUP");
    }
    if (!groupPrimes.has(name)) groupPrimes.set(name, call(DhGroup, name));
    initDh(this, groupPrimes.get(name), new Uint8Array([2]));
}

Object.assign(DiffieHellmanGroup.prototype, dhProto);

export const createDiffieHellman = (
    sizeOrKey: any,
    keyEncoding?: any,
    generator?: any,
    genEncoding?: any
) => new (DiffieHellman as any)(sizeOrKey, keyEncoding, generator, genEncoding);

export const createDiffieHellmanGroup = (name: string) =>
    new (DiffieHellmanGroup as any)(name);

// --- ECDH ---

const kEcdh = Symbol("kEcdh");

const checkFormat = (format?: string) => {
    if (format && !/^(compressed|hybrid|uncompressed)$/.test(format)) {
        throw fail("ERR_CRYPTO_ECDH_INVALID_FORMAT", format);
    }
    return format || "uncompressed";
};

function checkCurve(curve: string) {
    validateString(curve, "curve");
    if (!getCurves().includes(curve)) throw fail("ERR_CRYPTO_INVALID_CURVE");
    return curve;
}

export function ECDH(this: any, curve: string): any {
    if (!(this instanceof (ECDH as any))) return new (ECDH as any)(curve);
    this[kEcdh] = { curve: checkCurve(curve) };
}

function ecdhKey(self: any, kind: string) {
    const key = self[kEcdh][kind + "Key"];
    if (!key) throw fail("ERR_CRYPTO_OPERATION_FAILED", kind + " key");
    return key;
}

Object.assign(ECDH.prototype, {
    generateKeys(this: any, encoding?: string, format?: string) {
        const s = this[kEcdh];
        setKeys(s, call(EcdhGenerate, s.curve));
        return this.getPublicKey(encoding, format);
    },
    computeSecret(this: any, key: any, inEnc?: string, outEnc?: string) {
        const s = this[kEcdh];
        const other = toBytes(key, "key", inEnc);
        if (!s.privateKey) throw fail("ERR_CRYPTO_INVALID_KEYPAIR");
        return encode(call(EcdhCompute, s.curve, s.privateKey, other), outEnc);
    },
    // the other formats of an uncompressed 04 || X || Y need no call
    getPublicKey(this: any, encoding?: string, format?: string) {
        const point: Uint8Array = ecdhKey(this, "public");
        format = checkFormat(format);
        if (format === "uncompressed") return encode(point, encoding);
        const hybrid = format === "hybrid";
        const out = point.slice(
            0,
            hybrid ? point.length : (point.length + 1) / 2
        );
        out[0] = (hybrid ? 6 : 2) + (point[point.length - 1] & 1);
        return encode(out, encoding);
    },
    // as OpenSSL's BIGNUM gives it back: no leading zeros
    getPrivateKey(this: any, encoding?: string) {
        const key: Uint8Array = ecdhKey(this, "private");
        let i = 0;
        while (i < key.length - 1 && !key[i]) i++;
        return encode(key.subarray(i), encoding);
    },
    setPrivateKey(this: any, key: any, encoding?: string) {
        const s = this[kEcdh];
        setKeys(s, call(EcdhGenerate, s.curve, toBytes(key, "key", encoding)));
        return this;
    },
    setPublicKey(this: any, key: any, encoding?: string) {
        this[kEcdh].publicKey = toBytes(key, "key", encoding).slice();
        return this;
    }
});

(ECDH as any).convertKey = (
    key: any,
    curve: string,
    inEnc?: string,
    outEnc?: string,
    format?: string
) =>
    encode(
        call(
            EcdhConvertKey,
            checkCurve(curve),
            toBytes(key, "key", inEnc),
            checkFormat(format)
        ),
        outEnc
    );

export const createECDH = (curve: string) => new (ECDH as any)(curve);
