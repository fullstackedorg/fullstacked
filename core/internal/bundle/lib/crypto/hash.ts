// Hash and Hmac (lib/internal/crypto/hash.js). MD5, SHA-1 and SHA-2 run in
// TypeScript, incrementally: a bridge call costs more than hashing an ssh2
// packet (improvements/shim/plan.md 3.2). The other hashes buffer their input and make
// one core call at digest(); past a few megabytes the input moves to a
// core handle so a stream piped into a hash does not grow without bound.

import { Buffer } from "buffer";
import { Transform } from "stream";
import {
    Hash as HashFn,
    HashCopy,
    HashCreate,
    HashDigest,
    HashUpdate
} from "../@types/crypto.ts";
import { call, track, untrack } from "./core.ts";
import { createTsHash, createTsHmac, type TsHash } from "./primitives/index.ts";
import { HASH_SIZES, hashName } from "./names.ts";
import { secretBytes } from "./keys.ts";
import { encode, concat, toBytes } from "./util.ts";
import {
    fail,
    invalidArgType,
    invalidArgValue,
    validateString,
    validateUint32
} from "./errors.ts";

const DATA = "of type string or an instance of Buffer, TypedArray, or DataView";

// Node's LazyTransform: the stream state is built the first time the
// object is used as a stream, the update()/digest() path never pays for it
export function LazyTransform(this: any, options?: object) {
    this._options = options;
}
Object.setPrototypeOf(LazyTransform.prototype, Transform.prototype);
for (const name of ["_readableState", "_writableState"]) {
    Object.defineProperty(LazyTransform.prototype, name, {
        get(this: any) {
            (Transform as any).call(this, this._options);
            this._writableState.decodeStrings = false;
            return this[name];
        },
        set(this: any, value: unknown) {
            Object.defineProperty(this, name, {
                value,
                enumerable: true,
                configurable: true,
                writable: true
            });
        },
        configurable: true,
        enumerable: true
    });
}

// the _transform and _flush of Hash, Hmac and the ciphers
export function lazyStream(proto: any, update: string, final: string) {
    proto._transform = function (chunk: any, enc: string, cb: Function) {
        try {
            const out = this[update](chunk, enc);
            if (out !== undefined) this.push(out);
        } catch (e) {
            return cb(e);
        }
        cb();
    };
    proto._flush = function (cb: Function) {
        try {
            this.push(this[final]());
        } catch (e) {
            return cb(e);
        }
        cb();
    };
}

const BUFFER_LIMIT = 4 << 20;

// a hash in progress: a TS one, or the input kept for the core
class HashState {
    ts: TsHash | null;
    algorithm: string;
    key: Uint8Array | undefined;
    length: number | undefined;
    chunks: Uint8Array[] = [];
    size = 0;
    handle = 0;

    constructor(name: string, key?: Uint8Array, length?: number) {
        const algorithm = hashName(name);
        const size = HASH_SIZES[algorithm];
        if (!size) {
            throw key
                ? fail("ERR_CRYPTO_INVALID_DIGEST", ": " + name)
                : new Error("Digest method not supported");
        }
        const xof = algorithm.startsWith("shake");
        if (xof && key) throw new Error("error:00000000:lib(0)::reason(0)");
        if (length !== undefined && length !== size && !xof) {
            throw fail("ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH");
        }
        this.algorithm = algorithm;
        this.ts = key ? createTsHmac(algorithm, key) : createTsHash(algorithm);
        if (!this.ts) {
            this.key = key?.slice();
            this.length = xof ? length : undefined;
        }
    }

    update(data: Uint8Array) {
        if (this.ts) return this.ts.update(data);
        // the caller may reuse its buffer
        this.chunks.push(data.slice());
        this.size += data.length;
        if (this.size > BUFFER_LIMIT) this.flush();
    }

    flush() {
        if (!this.handle) {
            this.handle = call(
                HashCreate,
                this.algorithm,
                this.key,
                this.length
            );
            track(this, this.handle);
        }
        call(HashUpdate, this.handle, concat(this.chunks));
        this.chunks = [];
        this.size = 0;
    }

    digest(): Uint8Array {
        if (this.ts) return this.ts.digest();
        if (!this.handle) {
            return call(
                HashFn,
                this.algorithm,
                this.key,
                concat(this.chunks),
                this.length
            );
        }
        this.flush();
        untrack(this);
        return call(HashDigest, this.handle);
    }

    copy(length?: number): HashState {
        const copy: HashState = Object.assign(
            Object.create(HashState.prototype),
            this,
            { chunks: this.chunks.slice(), ts: this.ts?.copy() }
        );
        if (length !== undefined) {
            // the checks of a new hash with that length; an XOF on the core
            // keeps the new length
            const checked = new HashState(this.algorithm, null, length);
            if (!this.ts) copy.length = checked.length;
        }
        if (this.handle) {
            copy.handle = call(HashCopy, this.handle, copy.length);
            track(copy, copy.handle);
        }
        return copy;
    }
}

const kState = Symbol("kState");
const kFinalized = Symbol("kFinalized");

function outputLength(options: any) {
    const length = options?.outputLength;
    if (length !== undefined) validateUint32(length, "options.outputLength");
    return length;
}

function init(self: any, state: HashState, options: any) {
    self[kState] = state;
    self[kFinalized] = false;
    LazyTransform.call(self, options);
    return self;
}

function update(this: any, data: any, encoding?: string) {
    if (this[kFinalized]) throw fail("ERR_CRYPTO_HASH_FINALIZED");
    this[kState].update(toBytes(data, "data", encoding, DATA));
    return this;
}

// what digest() and _flush() give: an unknown encoding gives the Buffer
function digest(self: any, encoding: string, empty: boolean) {
    const out = empty ? new Uint8Array(0) : self[kState].digest();
    self[kFinalized] = true;
    return encode(out, Buffer.isEncoding(encoding) ? encoding : undefined);
}

export function Hash(this: any, algorithm: string, options?: any): any {
    if (!(this instanceof (Hash as any))) {
        return new (Hash as any)(algorithm, options);
    }
    validateString(algorithm, "algorithm");
    init(this, new HashState(algorithm, null, outputLength(options)), options);
}
Object.setPrototypeOf(Hash.prototype, LazyTransform.prototype);
lazyStream(Hash.prototype, "_update", "digest");

Hash.prototype.update = update;
Hash.prototype._update = function (this: any, data: any, encoding: string) {
    this[kState].update(toBytes(data, "data", encoding, DATA));
};

Hash.prototype.copy = function (this: any, options?: any) {
    if (this[kFinalized]) throw fail("ERR_CRYPTO_HASH_FINALIZED");
    const state = this[kState].copy(outputLength(options));
    return init(Object.create(Hash.prototype), state, options);
};

Hash.prototype.digest = function (this: any, encoding?: string) {
    if (this[kFinalized]) throw fail("ERR_CRYPTO_HASH_FINALIZED");
    return digest(this, encoding, false);
};

export function Hmac(this: any, hmac: string, key: any, options?: any): any {
    if (!(this instanceof (Hmac as any))) {
        return new (Hmac as any)(hmac, key, options);
    }
    validateString(hmac, "hmac");
    init(
        this,
        new HashState(hmac, secretBytes(key, options?.encoding)),
        options
    );
}
Object.setPrototypeOf(Hmac.prototype, LazyTransform.prototype);
lazyStream(Hmac.prototype, "_update", "digest");

Hmac.prototype.update = update;
Hmac.prototype._update = Hash.prototype._update;

// a second digest() gives an empty result, it does not throw
Hmac.prototype.digest = function (this: any, encoding?: string) {
    return digest(this, encoding, this[kFinalized]);
};

export const createHash = (algorithm: string, options?: any) =>
    new (Hash as any)(algorithm, options);

export const createHmac = (hmac: string, key: any, options?: any) =>
    new (Hmac as any)(hmac, key, options);

// crypto.hash(): no object
export function hash(algorithm: string, data: any, outputEncoding = "hex") {
    validateString(algorithm, "algorithm");
    if (typeof data !== "string" && !ArrayBuffer.isView(data)) {
        throw invalidArgType("input", DATA, data);
    }
    if (outputEncoding !== "buffer" && !Buffer.isEncoding(outputEncoding)) {
        throw invalidArgValue("outputEncoding", outputEncoding, "is invalid");
    }
    if (!HASH_SIZES[hashName(algorithm)]) {
        throw new Error(`Digest method ${algorithm} is not supported`);
    }
    const state = new HashState(algorithm);
    state.update(toBytes(data, "input"));
    return encode(state.digest(), outputEncoding);
}
