import * as c from "./index.js";
export * from "./index.js";

export const crypto: any = c.default;
export const getCurves = () => [];
crypto.getCurves = getCurves;

export function randomUUID(): string {
    const parentCrypto = c.default || c;
    if (
        parentCrypto &&
        typeof parentCrypto.randomUUID === "function" &&
        parentCrypto.randomUUID !== randomUUID
    ) {
        return parentCrypto.randomUUID();
    }

    const getRandomBytes = (size: number): Uint8Array => {
        const bytes = new Uint8Array(size);
        if (
            typeof globalThis.crypto !== "undefined" &&
            typeof globalThis.crypto.getRandomValues === "function"
        ) {
            globalThis.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < size; i++) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }
        return bytes;
    };

    const bytes = getRandomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex: string[] = [];
    for (let i = 0; i < 16; i++) {
        hex.push(bytes[i].toString(16).padStart(2, "0"));
    }

    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join("")
    ].join("-");
}

crypto.randomUUID = randomUUID;

// Ed25519 (RFC 8032): crypto-browserify has no KeyObject API, no one-shot sign/verify and no
// EdDSA (browserify-sign only parses RSA/EC/DSA keys and signs pre-hashed digests).
// BigInt arithmetic is not constant time: fine for verify, avoid signing with secrets on device.

type Point = { X: bigint; Y: bigint; Z: bigint; T: bigint };

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D =
    37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 =
    19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const G: Point = {
    X: 15112221349535400772501151409588531511454012693041857206046113283949847762202n,
    Y: 46316835694926478169428394003475163141307993866256225615783033603165251855960n,
    Z: 1n,
    T: 46827403850823179245072216630277197565144205554125654976674165829533817101731n
};
const IDENTITY: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n };

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from(
    "302e020100300506032b657004220420",
    "hex"
);

const mod = (a: bigint, m = P) => ((a % m) + m) % m;

function pow(base: bigint, exp: bigint): bigint {
    let result = 1n;
    base = mod(base);
    while (exp > 0n) {
        if (exp & 1n) result = mod(result * base);
        base = mod(base * base);
        exp >>= 1n;
    }
    return result;
}

const invert = (a: bigint) => pow(a, P - 2n);

// Unified addition on the twisted Edwards curve (a = -1); also used for doubling.
function add(p: Point, q: Point): Point {
    const A = mod((p.Y - p.X) * (q.Y - q.X));
    const B = mod((p.Y + p.X) * (q.Y + q.X));
    const C = mod(p.T * 2n * D * q.T);
    const Z2 = mod(p.Z * 2n * q.Z);
    const E = B - A;
    const F = Z2 - C;
    const H = Z2 + C;
    const I = B + A;
    return { X: mod(E * F), Y: mod(H * I), Z: mod(F * H), T: mod(E * I) };
}

function multiply(p: Point, n: bigint): Point {
    let result = IDENTITY;
    for (let i = 255n; i >= 0n; i--) {
        result = add(result, result);
        if ((n >> i) & 1n) result = add(result, p);
    }
    return result;
}

const negate = (p: Point): Point => ({
    X: mod(-p.X),
    Y: p.Y,
    Z: p.Z,
    T: mod(-p.T)
});

function bytesToNumberLE(bytes: Uint8Array): bigint {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        n = (n << 8n) | BigInt(bytes[i]);
    }
    return n;
}

function numberToBytesLE(n: bigint, length = 32): Buffer {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++, n >>= 8n) out[i] = Number(n & 0xffn);
    return out;
}

function encodePoint(p: Point): Buffer {
    const zInv = invert(p.Z);
    const x = mod(p.X * zInv);
    const out = numberToBytesLE(mod(p.Y * zInv));
    out[31] |= Number(x & 1n) << 7;
    return out;
}

function decodePoint(bytes: Uint8Array): Point | null {
    if (bytes.length !== 32) return null;
    const yBytes = Uint8Array.from(bytes);
    yBytes[31] &= 0x7f;
    const y = bytesToNumberLE(yBytes);
    if (y >= P) return null;
    const y2 = mod(y * y);
    const u = mod(y2 - 1n);
    const v = mod(D * y2 + 1n);
    const v3 = mod(v * v * v);
    let x = mod(u * v3 * pow(u * v3 * v3 * v, (P - 5n) / 8n));
    const vx2 = mod(v * x * x);
    if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
    else if (vx2 !== u) return null;
    const sign = BigInt(bytes[31] >> 7);
    if (x === 0n && sign === 1n) return null;
    if ((x & 1n) !== sign) x = mod(-x);
    return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

function sha512(...parts: Uint8Array[]): Buffer {
    const hash = crypto.createHash("sha512");
    for (const part of parts) hash.update(Buffer.from(part));
    return hash.digest();
}

function expandSeed(seed: Uint8Array) {
    const h = sha512(seed);
    const a = Buffer.from(h.subarray(0, 32));
    a[0] &= 248;
    a[31] &= 127;
    a[31] |= 64;
    const scalar = bytesToNumberLE(a);
    return {
        scalar,
        prefix: h.subarray(32),
        publicKey: encodePoint(multiply(G, scalar))
    };
}

function ed25519Sign(seed: Uint8Array, message: Uint8Array): Buffer {
    const { scalar, prefix, publicKey } = expandSeed(seed);
    const r = mod(bytesToNumberLE(sha512(prefix, message)), L);
    const R = encodePoint(multiply(G, r));
    const k = mod(bytesToNumberLE(sha512(R, publicKey, message)), L);
    return Buffer.concat([R, numberToBytesLE(mod(r + k * scalar, L))]);
}

// Cofactorless check like OpenSSL: encode([S]B - [k]A) must equal R byte for byte.
function ed25519Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array
): boolean {
    if (signature.length !== 64) return false;
    const A = decodePoint(publicKey);
    if (!A) return false;
    const R = signature.subarray(0, 32);
    const S = bytesToNumberLE(signature.subarray(32));
    if (S >= L) return false;
    const k = mod(bytesToNumberLE(sha512(R, publicKey, message)), L);
    const check = add(multiply(G, S), multiply(negate(A), k));
    return encodePoint(check).equals(Buffer.from(R));
}

type KeyType = "public" | "private";
type KeyInput =
    | string
    | Uint8Array
    | KeyObject
    | {
          key: string | Uint8Array | KeyObject | Record<string, string>;
          format?: "pem" | "der" | "jwk";
          type?: "spki" | "pkcs8";
          encoding?: BufferEncoding;
      };

/** Ed25519-only subset of node:crypto KeyObject. */
export class KeyObject {
    readonly asymmetricKeyType = "ed25519";
    readonly asymmetricKeyDetails = {};
    readonly type: KeyType;
    // 32-byte public key, or 32-byte seed for private keys
    private readonly raw: Buffer;

    constructor(type: KeyType, raw: Buffer) {
        if (raw.length !== 32) throw new Error("Invalid Ed25519 key length");
        this.type = type;
        this.raw = raw;
    }

    get rawPublicKey(): Buffer {
        return this.type === "public" ? this.raw : expandSeed(this.raw).publicKey;
    }

    get rawSeed(): Buffer {
        return this.raw;
    }

    export(options: { format?: string; type?: string } = {}) {
        if (options.format === "jwk") {
            const jwk: Record<string, string> = {
                kty: "OKP",
                crv: "Ed25519",
                x: this.rawPublicKey.toString("base64url")
            };
            if (this.type === "private") jwk.d = this.raw.toString("base64url");
            return jwk;
        }
        const prefix =
            this.type === "public" ? ED25519_SPKI_PREFIX : ED25519_PKCS8_PREFIX;
        const der = Buffer.concat([prefix, this.raw]);
        if (options.format === "der") return der;
        const label = this.type === "public" ? "PUBLIC KEY" : "PRIVATE KEY";
        const body = der.toString("base64").match(/.{1,64}/g)!.join("\n");
        return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
    }

    equals(other: KeyObject): boolean {
        return (
            other instanceof KeyObject &&
            other.type === this.type &&
            other.raw.equals(this.raw)
        );
    }
}

function parseDer(der: Buffer): KeyObject {
    const spkiLength = ED25519_SPKI_PREFIX.length;
    if (
        der.length === spkiLength + 32 &&
        der.subarray(0, spkiLength).equals(ED25519_SPKI_PREFIX)
    ) {
        return new KeyObject("public", Buffer.from(der.subarray(spkiLength)));
    }
    // PKCS#8 v1 (0x2e) or v2 with the public key attached (0x51/0x53): seed at offset 16.
    if (/^30(2e|51|53)02010[01]300506032b657004220420/.test(der.toString("hex"))) {
        return new KeyObject("private", Buffer.from(der.subarray(16, 48)));
    }
    throw new Error("Unsupported key: only Ed25519 keys are supported");
}

function parsePem(pem: string): KeyObject {
    const match =
        /-----BEGIN (PUBLIC KEY|PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(pem);
    if (!match) throw new Error("Invalid PEM: expected PUBLIC KEY or PRIVATE KEY");
    return parseDer(Buffer.from(match[2].replace(/\s+/g, ""), "base64"));
}

function parseJwk(jwk: Record<string, string>): KeyObject {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
        throw new Error("Unsupported JWK: only OKP Ed25519 keys are supported");
    }
    return jwk.d
        ? new KeyObject("private", Buffer.from(jwk.d, "base64url"))
        : new KeyObject("public", Buffer.from(jwk.x, "base64url"));
}

function toKeyObject(input: KeyInput): KeyObject {
    if (input instanceof KeyObject) return input;
    if (typeof input === "string") return parsePem(input);
    if (input instanceof Uint8Array) return parsePem(Buffer.from(input).toString());
    const { key, format, encoding } = input;
    if (key instanceof KeyObject) return key;
    if (format === "jwk") return parseJwk(key as Record<string, string>);
    if (format === "der") {
        return parseDer(
            typeof key === "string"
                ? Buffer.from(key, encoding ?? "base64")
                : Buffer.from(key as Uint8Array)
        );
    }
    return parsePem(
        typeof key === "string" ? key : Buffer.from(key as Uint8Array).toString()
    );
}

export function createPublicKey(key: KeyInput): KeyObject {
    const keyObject = toKeyObject(key);
    return keyObject.type === "public"
        ? keyObject
        : new KeyObject("public", keyObject.rawPublicKey);
}

export function createPrivateKey(key: KeyInput): KeyObject {
    const keyObject = toKeyObject(key);
    if (keyObject.type !== "private") {
        throw new Error("createPrivateKey: expected a private key");
    }
    return keyObject;
}

function toBytes(data: string | ArrayBufferView): Buffer {
    return typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function withCallback<T>(
    fn: () => T,
    callback?: (err: Error | null, result?: T) => void
): T | undefined {
    if (!callback) return fn();
    queueMicrotask(() => {
        let result: T;
        try {
            result = fn();
        } catch (err) {
            callback(err as Error);
            return;
        }
        callback(null, result);
    });
}

/** One-shot sign: Ed25519 when algorithm is null, otherwise createSign(algorithm). */
export function sign(
    algorithm: string | null | undefined,
    data: string | ArrayBufferView,
    key: KeyInput,
    callback?: (err: Error | null, signature?: Buffer) => void
): Buffer {
    return withCallback(() => {
        if (algorithm) {
            return crypto.createSign(algorithm).update(toBytes(data)).sign(key);
        }
        return ed25519Sign(createPrivateKey(key).rawSeed, toBytes(data));
    }, callback);
}

/** One-shot verify: Ed25519 when algorithm is null, otherwise createVerify(algorithm). */
export function verify(
    algorithm: string | null | undefined,
    data: string | ArrayBufferView,
    key: KeyInput,
    signature: ArrayBufferView,
    callback?: (err: Error | null, result?: boolean) => void
): boolean {
    return withCallback(() => {
        if (algorithm) {
            return crypto
                .createVerify(algorithm)
                .update(toBytes(data))
                .verify(key, toBytes(signature));
        }
        return ed25519Verify(
            createPublicKey(key).rawPublicKey,
            toBytes(data),
            toBytes(signature)
        );
    }, callback);
}

crypto.KeyObject = KeyObject;
crypto.createPublicKey = createPublicKey;
crypto.createPrivateKey = createPrivateKey;
crypto.sign = sign;
crypto.verify = verify;

export default crypto;
