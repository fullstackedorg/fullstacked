// Cipheriv and Decipheriv (lib/internal/crypto/cipher.js). AES-CTR and
// ChaCha20 run in TypeScript. The others go to the core as late and in as
// few calls as possible, ssh2 making a cipher per packet (improvements/shim/plan.md 5.2):
// - GCM and ChaCha20-Poly1305 with one update() then final(), the ssh2
//   case: ONE Aead call at update() gives the output and the tag; final()
//   makes no call when the tag is known (encrypting, or decrypting with the
//   tag set before update()), one Aead call to check a tag set after it;
// - a second update() moves to a handle: CipherInit with all the input so
//   far, of which only the new part's output is returned;
// - the other modes: CipherInit at the first update(), carrying what was
//   set before it, then CipherUpdate, and CipherFinal at final().

import { StringDecoder } from "string_decoder";
import {
    Aead,
    CipherFinal,
    CipherInit,
    CipherSetAutoPadding,
    CipherUpdate
} from "../@types/crypto.ts";
import { call, track, untrack } from "./core.ts";
import { LazyTransform, lazyStream } from "./hash.ts";
import { secretBytes } from "./keys.ts";
import { cipherInfo, type CipherInfo } from "./names.ts";
import {
    createAesCtr,
    createChaCha20,
    type TsStreamCipher
} from "./primitives/index.ts";
import { concat, EMPTY, toBuffer, toBytes } from "./util.ts";
import {
    fail,
    invalidState,
    STRING_OR_BYTES,
    uintOption,
    validateString
} from "./errors.ts";

const DATA = "of type string or an instance of Buffer, TypedArray, or DataView";

type State = {
    info: CipherInfo;
    decrypt: boolean;
    aead: boolean;
    ts: TsStreamCipher | null;
    key: Uint8Array;
    iv: Uint8Array | undefined;
    tagLength: number | undefined;
    padding: boolean;
    aad: Uint8Array | undefined;
    // decrypting: the expected tag; encrypting: the tag of the output
    tag: Uint8Array | undefined;
    // the expected tag went to the core along with the data
    tagSent: boolean;
    handle: number;
    // the input of the one Aead call, for a second update() or a late tag
    input: Uint8Array | null;
    // what that call said of the tag when decrypting: 0 none, 1 good, 2 bad
    verdict: number;
    // 0 before update(), 1 updating, 2 final() called
    phase: number;
    decoder: StringDecoder | null;
    encoding: string;
};

const kState = Symbol("kState");

const authFailed = () =>
    new Error("Unsupported state or unable to authenticate data");

const validTagLength = (info: CipherInfo, n: number) =>
    info.mode === "gcm"
        ? n === 4 || n === 8 || (n >= 12 && n <= 16)
        : n >= 1 && n <= 16;

// Node's checks, in Node's order, before anything reaches the core
function init(
    self: any,
    cipher: string,
    key: any,
    iv: any,
    options: any,
    decrypt: boolean
) {
    validateString(cipher, "cipher");
    const encoding = options?.encoding;
    const keyBytes = secretBytes(key, encoding);
    const ivBytes =
        iv === null ? undefined : toBytes(iv, "iv", encoding, STRING_OR_BYTES);
    const info = cipherInfo(cipher);
    if (!info) throw fail("ERR_CRYPTO_UNKNOWN_CIPHER");
    const n = ivBytes?.length ?? 0;
    if (info.mode === "gcm" ? n < 1 || n > 128 : n !== info.ivLength) {
        throw fail("ERR_CRYPTO_INVALID_IV");
    }
    // single DES is in OpenSSL's legacy provider, which Node 24 does not load
    if (info.mode === "des") throw fail("ERR_OSSL_EVP_UNSUPPORTED");
    const aead = info.mode === "gcm" || info.mode === "poly1305";
    const tagLength = uintOption(options, "authTagLength");
    if (aead && tagLength !== undefined && !validTagLength(info, tagLength)) {
        throw fail("ERR_CRYPTO_INVALID_AUTH_TAG", tagLength);
    }
    if (keyBytes.length !== info.keyLength) {
        throw fail("ERR_CRYPTO_INVALID_KEYLEN");
    }
    const ts =
        info.mode === "ctr"
            ? createAesCtr(keyBytes, ivBytes)
            : info.mode === "chacha20"
              ? createChaCha20(keyBytes, ivBytes)
              : null;
    self[kState] = {
        info,
        decrypt,
        aead,
        ts,
        key: keyBytes.slice(),
        iv: ivBytes?.slice(),
        tagLength,
        padding: true,
        phase: 0
    } as State;
    LazyTransform.call(self, options);
}

// CipherInit with what was set so far: the handle, then the output of data
function open(s: State, data?: Uint8Array): Uint8Array {
    const tag = s.decrypt ? s.tag : undefined;
    const r: Uint8Array = call(
        CipherInit,
        s.info.name,
        s.key,
        s.iv,
        s.decrypt,
        s.tagLength,
        s.padding,
        s.aad,
        tag,
        data
    );
    s.handle = ((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0;
    s.tagSent = !!tag;
    track(s, s.handle);
    return r.subarray(4);
}

function finish(s: State, tag?: Uint8Array): Uint8Array {
    const handle = s.handle;
    s.handle = 0;
    untrack(s);
    return call(CipherFinal, handle, tag);
}

const aeadOneShot = (s: State, data: Uint8Array, tag?: Uint8Array) =>
    call(
        Aead,
        s.info.name,
        s.key,
        s.iv,
        s.decrypt,
        s.tagLength,
        s.aad,
        tag,
        data
    ) as Uint8Array;

function update(s: State, data: Uint8Array): Uint8Array {
    if (s.ts) return s.ts.update(data);
    if (s.handle) return call(CipherUpdate, s.handle, data);
    if (!s.aead) return open(s, data);

    if (s.phase === 0) {
        const tag = s.decrypt ? s.tag : undefined;
        const r = aeadOneShot(s, data, tag);
        s.input = data.slice();
        s.tagSent = !!tag;
        if (s.decrypt) {
            s.verdict = r[0];
            return r.subarray(1);
        }
        s.tag = r.subarray(1 + data.length);
        return r.subarray(1, 1 + data.length);
    }

    // a second update(): the first one is replayed in a handle
    const first = s.input;
    s.input = null;
    if (!s.decrypt) s.tag = undefined;
    return open(s, concat([first, data])).subarray(first.length);
}

function final(s: State): Uint8Array {
    if (s.ts) return EMPTY;
    if (!s.aead) {
        // nothing written: a padding block to encrypt, or an error to report
        if (!s.handle) open(s);
        return finish(s);
    }
    if (s.handle) {
        const out = finish(s, s.decrypt && !s.tagSent ? s.tag : undefined);
        if (s.decrypt) return out;
        const n = out.length - (s.tagLength ?? 16);
        s.tag = out.subarray(n);
        return out.subarray(0, n);
    }
    if (s.phase === 0) {
        if (s.decrypt && !s.tag) throw authFailed();
        update(s, EMPTY);
    }
    const input = s.input;
    s.input = null;
    if (s.decrypt) {
        if (!s.tagSent) {
            if (!s.tag) throw authFailed();
            s.verdict = aeadOneShot(s, input, s.tag)[0];
        }
        if (s.verdict !== 1) throw authFailed();
    }
    return EMPTY;
}

// Node decodes the output through one StringDecoder per cipher, which
// holds partial characters and base64 groups back across calls
function output(s: State, bytes: Uint8Array, encoding: string, end: boolean) {
    const buffer = toBuffer(bytes);
    if (!encoding || encoding === "buffer") return buffer;
    if (!s.decoder) {
        s.decoder = new StringDecoder(encoding as BufferEncoding);
    } else if (
        encoding !== s.encoding &&
        (new StringDecoder(encoding as BufferEncoding) as any).encoding !==
            (s.decoder as any).encoding
    ) {
        throw fail("ERR_INTERNAL_ASSERTION");
    }
    s.encoding = encoding;
    return end ? s.decoder.end(buffer) : s.decoder.write(buffer);
}

const base = Object.create(LazyTransform.prototype);

base.update = function (
    this: any,
    data: any,
    inputEncoding?: string,
    outputEncoding?: string
) {
    const s: State = this[kState];
    if (s.phase === 2) {
        throw new Error("Trying to add data in unsupported state");
    }
    const out = update(s, toBytes(data, "data", inputEncoding, DATA));
    s.phase = 1;
    return output(s, out, outputEncoding, false);
};

base.final = function (this: any, outputEncoding?: string) {
    const s: State = this[kState];
    if (s.phase === 2) throw invalidState();
    let out: Uint8Array;
    try {
        out = final(s);
    } finally {
        s.phase = 2;
    }
    return output(s, out, outputEncoding, true);
};

base.setAutoPadding = function (this: any, ap?: boolean) {
    const s: State = this[kState];
    if (s.phase === 2) throw invalidState("setAutoPadding");
    s.padding = !!ap;
    if (s.handle && !s.aead) {
        call(CipherSetAutoPadding, s.handle, s.padding);
    }
    return this;
};

base.setAAD = function (this: any, buffer: any, options?: any) {
    const s: State = this[kState];
    const aad = toBytes(buffer, "buffer", options?.encoding, STRING_OR_BYTES);
    if (!s.aead || s.phase !== 0) throw invalidState("setAAD");
    s.aad = s.aad ? concat([s.aad, aad]) : aad.slice();
    return this;
};

lazyStream(base, "update", "final");

export function Cipheriv(
    this: any,
    cipher: string,
    key: any,
    iv: any,
    options?: any
): any {
    if (!(this instanceof (Cipheriv as any))) {
        return new (Cipheriv as any)(cipher, key, iv, options);
    }
    init(this, cipher, key, iv, options, false);
}
Object.setPrototypeOf(Cipheriv.prototype, base);

Cipheriv.prototype.getAuthTag = function (this: any) {
    const s: State = this[kState];
    if (s.phase !== 2 || !s.aead || !s.tag) throw invalidState("getAuthTag");
    return toBuffer(s.tag.slice());
};

export function Decipheriv(
    this: any,
    cipher: string,
    key: any,
    iv: any,
    options?: any
): any {
    if (!(this instanceof (Decipheriv as any))) {
        return new (Decipheriv as any)(cipher, key, iv, options);
    }
    init(this, cipher, key, iv, options, true);
}
Object.setPrototypeOf(Decipheriv.prototype, base);

Decipheriv.prototype.setAuthTag = function (
    this: any,
    tagbuf: any,
    encoding?: string
) {
    const s: State = this[kState];
    const tag = toBytes(tagbuf, "buffer", encoding, STRING_OR_BYTES);
    if (!s.aead || s.phase === 2 || s.tag) throw invalidState("setAuthTag");
    const n = tag.length;
    if (
        s.tagLength !== undefined
            ? n !== s.tagLength
            : s.info.mode === "gcm"
              ? !validTagLength(s.info, n)
              : n !== 16
    ) {
        throw fail("ERR_CRYPTO_INVALID_AUTH_TAG", n);
    }
    s.tag = tag.slice();
    return this;
};

export const createCipheriv = (
    cipher: string,
    key: any,
    iv: any,
    options?: any
) => new (Cipheriv as any)(cipher, key, iv, options);

export const createDecipheriv = (
    cipher: string,
    key: any,
    iv: any,
    options?: any
) => new (Decipheriv as any)(cipher, key, iv, options);
