import test, { suite } from "node:test";
import assert from "node:assert";
import nodeCrypto from "node:crypto";
import * as nodeStream from "node:stream";
import { pipeline as nodePipeline } from "node:stream/promises";
import { promisify } from "node:util";
import libCrypto from "../../../core/internal/bundle/lib/crypto/index.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import * as libStream from "../../../core/internal/bundle/lib/stream/index.ts";
import { pipeline as libPipeline } from "../../../core/internal/bundle/lib/stream/promises.ts";
import { errorShape, sameFor } from "../common.ts";

type CryptoModule = typeof nodeCrypto;
type Env = {
    crypto: CryptoModule;
    Buffer: typeof Buffer;
    stream: typeof nodeStream;
    pipeline: typeof nodePipeline;
};
const crypto = libCrypto as unknown as CryptoModule;
const shim: Env = {
    crypto,
    Buffer: (libBuffer as any).Buffer,
    stream: ((libStream as any).default ?? libStream) as typeof nodeStream,
    pipeline: libPipeline as typeof nodePipeline
};
const node: Env = {
    crypto: nodeCrypto,
    Buffer,
    stream: nodeStream,
    pipeline: nodePipeline
};
// error codes of crypto come from OpenSSL and change with the Node patch
// release (24.16 and 24.20 differ): a case passes when the shim throws
// where Node does, whatever the code
const same = sameFor<Env>("crypto", shim, node, { errors: "thrown" });

// RFC 8032 section 7.1 test vectors (seed, public key, message, signature)
const RFC8032 = [
    [
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    ],
    [
        "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    ],
    [
        "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
        "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
        "af82",
        "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"
    ]
];

const hex = (s: string) => Buffer.from(s, "hex");
const privateFromSeed = (seed: string) =>
    crypto.createPrivateKey({
        key: Buffer.concat([
            hex("302e020100300506032b657004220420"),
            hex(seed)
        ]),
        format: "der",
        type: "pkcs8"
    });

suite("shim crypto - ed25519 (lib/crypto)", () => {
    test("RFC 8032 vectors: public key, sign and verify", () => {
        for (const [seed, pub, msg, sig] of RFC8032) {
            const privateKey = privateFromSeed(seed);
            const publicKey = crypto.createPublicKey(privateKey);
            assert.equal(
                publicKey.export({ format: "jwk" }).x,
                hex(pub).toString("base64url")
            );
            assert.equal(
                crypto.sign(null, hex(msg), privateKey).toString("hex"),
                sig
            );
            assert.equal(
                crypto.verify(null, hex(msg), publicKey, hex(sig)),
                true
            );
        }
    });

    test("interoperates with node:crypto keys and signatures", () => {
        const { privateKey, publicKey } =
            nodeCrypto.generateKeyPairSync("ed25519");
        const privatePem = privateKey.export({
            format: "pem",
            type: "pkcs8"
        }) as string;
        const publicDer = publicKey.export({ format: "der", type: "spki" });
        const message = Buffer.from(
            "https://i.fullstacked.cloud/?exp=1791350554"
        );

        const nodeSig = nodeCrypto.sign(null, message, privateKey);
        const pub = crypto.createPublicKey({
            key: publicDer,
            format: "der",
            type: "spki"
        });
        assert.equal(crypto.verify(null, message, pub, nodeSig), true);

        const ourSig = crypto.sign(null, message, privatePem);
        assert.deepEqual(ourSig, nodeSig);
        assert.equal(nodeCrypto.verify(null, message, publicKey, ourSig), true);
        assert.equal(
            crypto
                .createPublicKey(privatePem)
                .export({ format: "pem", type: "spki" }),
            publicKey.export({ format: "pem", type: "spki" })
        );
    });

    test("rejects tampered messages, signatures and non-canonical S", () => {
        const [seed, , msg, sig] = RFC8032[1];
        const publicKey = crypto.createPublicKey(privateFromSeed(seed));
        assert.equal(
            crypto.verify(null, hex("73"), publicKey, hex(sig)),
            false
        );
        const flipped = hex(sig);
        flipped[10] ^= 1;
        assert.equal(crypto.verify(null, hex(msg), publicKey, flipped), false);
        // S + L encodes the same scalar but must be refused (malleability)
        const L = 2n ** 252n + 27742317777372353535851937790883648493n;
        let s = 0n;
        const sigBytes = hex(sig);
        for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sigBytes[i]);
        s += L;
        for (let i = 32; i < 64; i++, s >>= 8n) sigBytes[i] = Number(s & 0xffn);
        assert.equal(crypto.verify(null, hex(msg), publicKey, sigBytes), false);
        assert.equal(
            crypto.verify(null, hex(msg), publicKey, hex(sig).subarray(0, 63)),
            false
        );
    });

    test("verify reports through a callback", async () => {
        const [seed, , msg, sig] = RFC8032[2];
        const publicKey = crypto.createPublicKey(privateFromSeed(seed));
        const result = await new Promise((resolve, reject) =>
            crypto.verify(
                null,
                hex(msg),
                publicKey,
                hex(sig),
                (err: Error, ok: boolean) => (err ? reject(err) : resolve(ok))
            )
        );
        assert.equal(result, true);
    });
});

// Node's Buffer of a value made by either side (the shim's Buffer is
// another class); values handed to an implementation are made with its own
// Buffer, as in the webview where every Buffer is the shim's
const nodeBuffer = (value: ArrayLike<number> | ArrayBufferView) =>
    ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(value as ArrayLike<number>);

// inputs shared by both sides; keys are generated once by Node and passed
// as PEM/DER, which is how ssh2 and pg hand them over
const DATA = Buffer.from(
    "The quick brown fox jumps over the lazy dog. ".repeat(40)
);
const KEY32 = Buffer.alloc(32, 0x11);
const KEY24 = Buffer.alloc(24, 0x22);
const KEY16 = Buffer.alloc(16, 0x33);
const IV16 = Buffer.alloc(16, 0x44);
const IV12 = Buffer.alloc(12, 0x55);
const rsa = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PRIVATE = rsa.privateKey.export({
    type: "pkcs8",
    format: "pem"
}) as string;
const RSA_PRIVATE_PKCS1 = rsa.privateKey.export({
    type: "pkcs1",
    format: "pem"
}) as string;
const RSA_PUBLIC = rsa.publicKey.export({
    type: "spki",
    format: "pem"
}) as string;
const ec = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const EC_PRIVATE = ec.privateKey.export({
    type: "sec1",
    format: "pem"
}) as string;
const EC_PUBLIC = ec.publicKey.export({
    type: "spki",
    format: "pem"
}) as string;
const ECDSA_SIG = nodeCrypto.sign("sha256", DATA, ec.privateKey);

suite("shim crypto - hashes and hmac", () => {
    for (const algorithm of [
        "md5",
        "sha1",
        "sha224",
        "sha256",
        "sha384",
        "sha512",
        "ripemd160",
        "sha512-256",
        "sha3-256"
    ]) {
        same(`createHash ${algorithm}`, ({ crypto }) => [
            crypto.createHash(algorithm).update(DATA).digest("hex"),
            crypto.createHash(algorithm).update("").digest("base64"),
            crypto
                .createHash(algorithm)
                .update("é", "utf8")
                .update("ff", "hex")
                .digest()
        ]);
        same(`createHmac ${algorithm}`, ({ crypto }) => [
            crypto.createHmac(algorithm, KEY32).update(DATA).digest("hex"),
            crypto
                .createHmac(algorithm, "x".repeat(200))
                .update("m")
                .digest("base64")
        ]);
    }
    same("digest twice throws", ({ crypto }) => {
        const h = crypto.createHash("sha256");
        h.digest();
        return h.digest();
    });
    same("hash.copy", ({ crypto }) => {
        const h = crypto.createHash("sha256").update("a");
        const c = h.copy();
        return [h.update("b").digest("hex"), c.digest("hex")];
    });
    same("createHash as a stream", async ({ crypto }) => {
        const h = crypto.createHash("sha1");
        h.end("streamed");
        return (h.read() as Buffer)?.toString("hex");
    });
    same("crypto.hash one-shot", ({ crypto }) =>
        (crypto as any).hash("sha256", "x")
    );
    same("unknown hash", ({ crypto }) => crypto.createHash("nope"));
    same("getHashes includes the common ones", ({ crypto }) =>
        ["md5", "sha1", "sha256", "sha512", "RSA-SHA256"].map((h) =>
            crypto
                .getHashes()
                .map((x) => x.toLowerCase())
                .includes(h.toLowerCase())
        )
    );
});

suite("shim crypto - ciphers", () => {
    const ciphers: [string, Buffer, Buffer | null][] = [
        ["aes-128-cbc", KEY16, IV16],
        ["aes-192-cbc", KEY24, IV16],
        ["aes-256-cbc", KEY32, IV16],
        ["aes-128-ctr", KEY16, IV16],
        ["aes-256-ctr", KEY32, IV16],
        ["aes-128-ecb", KEY16, null],
        ["aes-128-cfb", KEY16, IV16],
        ["aes-128-ofb", KEY16, IV16],
        ["des-ede3-cbc", KEY24, IV16.subarray(0, 8)],
        ["chacha20", KEY32, IV16]
    ];
    for (const [algorithm, key, iv] of ciphers) {
        same(`${algorithm} encrypt and decrypt`, ({ crypto }) => {
            const cipher = crypto.createCipheriv(algorithm, key, iv);
            const encrypted = Buffer.concat([
                cipher.update(DATA.subarray(0, 1000)),
                cipher.final()
            ]);
            const decipher = crypto.createDecipheriv(algorithm, key, iv);
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
            return [encrypted, decrypted.equals(DATA.subarray(0, 1000))];
        });
    }
    same("update in pieces with encodings", ({ crypto }) => {
        const cipher = crypto.createCipheriv("aes-128-ctr", KEY16, IV16);
        const base64 = crypto.createCipheriv("aes-128-ctr", KEY16, IV16);
        return [
            cipher.update("abc", "utf8", "hex"),
            cipher.update(Buffer.from("def"), undefined, "hex"),
            // the output encoding cannot change between calls
            attempt(() => cipher.update("g", "utf8", "base64")),
            cipher.final("hex"),
            base64.update("abcd", "utf8", "base64"),
            base64.update("e", "utf8", "base64"),
            base64.final("base64")
        ];
    });
    for (const [algorithm, key] of [
        ["aes-128-gcm", KEY16],
        ["aes-256-gcm", KEY32],
        ["chacha20-poly1305", KEY32]
    ] as const) {
        same(`${algorithm} with AAD and tag`, ({ crypto }) => {
            const cipher = crypto.createCipheriv(algorithm, key, IV12, {
                authTagLength: 16
            } as any) as any;
            cipher.setAAD(Buffer.from("header"));
            const encrypted = Buffer.concat([
                cipher.update(DATA.subarray(0, 300)),
                cipher.final()
            ]);
            const tag = cipher.getAuthTag();
            const decipher = crypto.createDecipheriv(algorithm, key, IV12, {
                authTagLength: 16
            } as any) as any;
            decipher.setAAD(Buffer.from("header"));
            decipher.setAuthTag(tag);
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
            return [encrypted, tag, decrypted.length];
        });
        same(`${algorithm} rejects a bad tag`, ({ crypto }) => {
            const decipher = crypto.createDecipheriv(algorithm, key, IV12, {
                authTagLength: 16
            } as any) as any;
            decipher.setAuthTag(Buffer.alloc(16));
            decipher.update(Buffer.from("x"));
            return decipher.final();
        });
    }
    same("setAutoPadding(false) with a partial block", ({ crypto }) => {
        const cipher = crypto.createCipheriv("aes-128-cbc", KEY16, IV16);
        cipher.setAutoPadding(false);
        cipher.update(Buffer.alloc(5));
        return cipher.final();
    });
    same("decrypt with a wrong padding", ({ crypto }) => {
        const decipher = crypto.createDecipheriv("aes-128-cbc", KEY16, IV16);
        decipher.update(Buffer.alloc(16, 1));
        return decipher.final();
    });
    same("invalid key length", ({ crypto }) =>
        crypto.createCipheriv("aes-128-cbc", Buffer.alloc(5), IV16)
    );
    same("unknown cipher", ({ crypto }) =>
        crypto.createCipheriv("nope-128", KEY16, IV16)
    );
    same("getCiphers includes the ssh2 ones", ({ crypto }) =>
        [
            "aes-128-ctr",
            "aes-256-gcm",
            "chacha20-poly1305",
            "des-ede3-cbc",
            "aes128-gcm@openssh.com"
        ].map((c) => crypto.getCiphers().includes(c))
    );
    same("getCurves", ({ crypto }) =>
        ["prime256v1", "secp384r1", "secp521r1", "secp256k1"].map((c) =>
            crypto.getCurves().includes(c)
        )
    );
});

suite("shim crypto - key derivation and random", () => {
    for (const digest of ["sha1", "sha256", "sha512"]) {
        same(`pbkdf2Sync ${digest}`, ({ crypto }) =>
            crypto.pbkdf2Sync("password", "salt", 1000, 48, digest)
        );
    }
    same(
        "pbkdf2 callback",
        async ({ crypto }) =>
            new Promise((resolve, reject) =>
                crypto.pbkdf2("pw", "salt", 10, 16, "sha256", (e, key) =>
                    e ? reject(e) : resolve(key)
                )
            )
    );
    same("scryptSync", ({ crypto }) =>
        crypto.scryptSync("password", "salt", 32, { N: 1024 })
    );
    same("hkdfSync", ({ crypto }) =>
        Buffer.from(crypto.hkdfSync("sha256", KEY32, "salt", "info", 42))
    );
    same(
        "randomBytes, randomFillSync, randomInt, randomUUID shapes",
        ({ crypto }) => [
            crypto.randomBytes(16).length,
            crypto.randomFillSync(new Uint8Array(8)).length,
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every(() => {
                const n = crypto.randomInt(3, 7);
                return n >= 3 && n < 7;
            }),
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                crypto.randomUUID()
            )
        ]
    );
    same(
        "randomBytes callback",
        async ({ crypto }) =>
            new Promise((resolve, reject) =>
                crypto.randomBytes(4, (e, b) =>
                    e ? reject(e) : resolve(b.length)
                )
            )
    );
    same("timingSafeEqual", ({ crypto }) => [
        crypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("ab")),
        crypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("ac"))
    ]);
    same("timingSafeEqual with different lengths", ({ crypto }) =>
        crypto.timingSafeEqual(Buffer.from("a"), Buffer.from("ab"))
    );
    same("webcrypto and subtle", ({ crypto }) => [
        typeof crypto.webcrypto?.subtle?.digest,
        typeof crypto.subtle?.digest,
        typeof crypto.getRandomValues
    ]);
    same("constants", ({ crypto }) => [
        crypto.constants?.RSA_PKCS1_PADDING,
        crypto.constants?.RSA_PKCS1_OAEP_PADDING,
        crypto.constants?.RSA_PKCS1_PSS_PADDING
    ]);
});

suite("shim crypto - asymmetric", () => {
    same("RSA-SHA256 sign (PKCS#1 v1.5 is deterministic)", ({ crypto }) =>
        crypto.createSign("RSA-SHA256").update(DATA).sign(RSA_PRIVATE)
    );
    same("sign with a PKCS#1 key", ({ crypto }) =>
        crypto
            .createSign("sha256")
            .update(DATA)
            .sign(RSA_PRIVATE_PKCS1, "base64")
    );
    same("one-shot sign sha256 RSA", ({ crypto }) =>
        crypto.sign("sha256", DATA, RSA_PRIVATE)
    );
    same("RSA verify", ({ crypto, Buffer }) => {
        const signature = Buffer.from(
            nodeCrypto.sign("sha512", DATA, rsa.privateKey)
        );
        return [
            crypto
                .createVerify("RSA-SHA512")
                .update(DATA)
                .verify(RSA_PUBLIC, signature),
            crypto
                .createVerify("RSA-SHA512")
                .update("other")
                .verify(RSA_PUBLIC, signature)
        ];
    });
    same("RSA-PSS sign verifies", ({ crypto }) => {
        const signature = crypto.sign("sha256", DATA, {
            key: RSA_PRIVATE,
            padding: crypto.constants?.RSA_PKCS1_PSS_PADDING ?? 6
        });
        return nodeCrypto.verify(
            "sha256",
            DATA,
            {
                key: rsa.publicKey,
                padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING
            },
            signature
        );
    });
    same("ECDSA P-256 verify a Node signature", ({ crypto, Buffer }) =>
        crypto
            .createVerify("sha256")
            .update(DATA)
            .verify(EC_PUBLIC, Buffer.from(ECDSA_SIG))
    );
    same("ECDSA P-256 sign verifies in Node", ({ crypto }) => {
        const signature = crypto
            .createSign("sha256")
            .update(DATA)
            .sign(EC_PRIVATE);
        return nodeCrypto.verify("sha256", DATA, ec.publicKey, signature);
    });
    same("ECDSA with dsaEncoding ieee-p1363", ({ crypto }) => {
        const signature = crypto.sign("sha256", DATA, {
            key: EC_PRIVATE,
            dsaEncoding: "ieee-p1363"
        });
        return signature.length;
    });
    same("publicEncrypt and privateDecrypt (OAEP)", ({ crypto }) => {
        const encrypted = crypto.publicEncrypt(
            RSA_PUBLIC,
            Buffer.from("secret")
        );
        return [
            encrypted.length,
            crypto.privateDecrypt(RSA_PRIVATE, encrypted).toString()
        ];
    });
    same(
        "createPublicKey and createPrivateKey of RSA and EC PEM",
        ({ crypto }) =>
            [RSA_PUBLIC, EC_PUBLIC]
                .map((pem) => {
                    const k = crypto.createPublicKey(pem);
                    return [
                        k.type,
                        k.asymmetricKeyType,
                        k.asymmetricKeyDetails
                    ];
                })
                .concat(
                    [RSA_PRIVATE, EC_PRIVATE].map((pem) => {
                        const k = crypto.createPrivateKey(pem);
                        return [k.type, k.asymmetricKeyType];
                    })
                )
    );
    same("KeyObject export as jwk and der", ({ crypto }) => {
        const k = crypto.createPublicKey(EC_PUBLIC);
        return [
            k.export({ format: "jwk" }),
            k.export({ format: "der", type: "spki" })
        ];
    });
    same("createSecretKey", ({ crypto }) => {
        const k = crypto.createSecretKey(KEY16);
        return [k.type, k.symmetricKeySize, k.export()];
    });
    for (const type of ["rsa", "ec", "ed25519", "x25519"] as const) {
        same(`generateKeyPairSync ${type}`, ({ crypto }) => {
            const options: any =
                type === "rsa"
                    ? { modulusLength: 1024 }
                    : type === "ec"
                      ? { namedCurve: "P-256" }
                      : {};
            const { publicKey, privateKey } = crypto.generateKeyPairSync(
                type as any,
                options
            ) as any;
            return [
                publicKey.type,
                privateKey.type,
                publicKey.asymmetricKeyType
            ];
        });
    }
    same(
        "generateKeyPair callback ed25519",
        async ({ crypto }) =>
            new Promise((resolve, reject) =>
                crypto.generateKeyPair("ed25519", {}, (e, pub) =>
                    e ? reject(e) : resolve(pub.type)
                )
            )
    );
    same("x25519 diffieHellman with Node keys", ({ crypto }) => {
        const a = nodeCrypto.generateKeyPairSync("x25519");
        const b = nodeCrypto.generateKeyPairSync("x25519");
        const expected = nodeCrypto.diffieHellman({
            privateKey: a.privateKey,
            publicKey: b.publicKey
        });
        const privateKey = crypto.createPrivateKey(
            a.privateKey.export({ type: "pkcs8", format: "pem" })
        );
        const publicKey = crypto.createPublicKey(
            b.publicKey.export({ type: "spki", format: "pem" })
        );
        return crypto.diffieHellman({ privateKey, publicKey }).equals(expected);
    });
    for (const curve of ["prime256v1", "secp384r1", "secp256k1"]) {
        same(
            `createECDH ${curve} computes Node's secret`,
            ({ crypto, Buffer }) => {
                const ours = crypto.createECDH(curve);
                ours.setPrivateKey(Buffer.alloc(32, 7));
                const theirs = nodeCrypto.createECDH(curve);
                theirs.generateKeys();
                return [
                    ours.getPublicKey(),
                    nodeBuffer(
                        ours.computeSecret(Buffer.from(theirs.getPublicKey()))
                    ).equals(
                        theirs.computeSecret(nodeBuffer(ours.getPublicKey()))
                    )
                ];
            }
        );
    }
    same("createDiffieHellmanGroup modp14 with a fixed key", ({ crypto }) => {
        const dh = crypto.createDiffieHellmanGroup("modp14");
        (dh as any).setPrivateKey(Buffer.alloc(32, 9));
        (dh as any).generateKeys();
        return dh.getPublicKey().subarray(0, 16);
    });
    same(
        "createDiffieHellman(prime, generator) agrees with Node",
        ({ crypto, Buffer }) => {
            const ref = nodeCrypto.createDiffieHellmanGroup("modp2");
            const ours = crypto.createDiffieHellman(
                Buffer.from(ref.getPrime()),
                Buffer.from([2])
            );
            ours.generateKeys();
            const theirs = nodeCrypto.createDiffieHellman(
                ref.getPrime(),
                nodeBuffer([2])
            );
            theirs.generateKeys();
            return nodeBuffer(
                ours.computeSecret(Buffer.from(theirs.getPublicKey()))
            ).equals(theirs.computeSecret(nodeBuffer(ours.getPublicKey())));
        }
    );
});

// what a call gives, its error's name and code when it throws, so that one
// case can compare several outcomes
const attempt = (fn: () => unknown) => {
    try {
        return fn();
    } catch (e) {
        return errorShape(e);
    }
};

const callback = <T>(start: (cb: (e: Error, v: T) => void) => void) =>
    new Promise<T>((resolve, reject) =>
        start((e, v) => (e ? reject(e) : resolve(v)))
    );

const RSA_PUBLIC_PKCS1 = rsa.publicKey.export({
    type: "pkcs1",
    format: "pem"
}) as string;
const EC_PRIVATE_PKCS8 = ec.privateKey.export({
    type: "pkcs8",
    format: "der"
});
const ED25519_PRIVATE = Buffer.concat([
    hex("302e020100300506032b657004220420"),
    hex(RFC8032[0][0])
]);
const X25519_PRIVATE = hex(
    "302e020100300506032b656e04220420a0a662447160ef6d32cad7e5c8c82a94e08b968c8c2a0c3f634ef09ed3adff7f"
);

suite("shim crypto - AEAD and cipher state", () => {
    for (const [algorithm, key] of [
        ["aes-128-gcm", KEY16],
        ["chacha20-poly1305", KEY32]
    ] as const) {
        same(
            `${algorithm} in several updates, tag set after update`,
            ({ crypto }) => {
                const aad = Buffer.from("length");
                const cipher = crypto.createCipheriv(algorithm, key, IV12, {
                    authTagLength: 16
                } as any) as any;
                cipher.setAAD(aad);
                const encrypted = Buffer.concat([
                    cipher.update(DATA.subarray(0, 100)),
                    cipher.update(DATA.subarray(100, 333)),
                    cipher.update(DATA.subarray(333, 1000)),
                    cipher.final()
                ]);
                const tag = cipher.getAuthTag();

                const decrypt = (pieces: Buffer[], tagAt: number, t = tag) => {
                    const decipher = crypto.createDecipheriv(
                        algorithm,
                        key,
                        IV12,
                        {
                            authTagLength: 16
                        } as any
                    ) as any;
                    decipher.setAAD(aad);
                    const out: Buffer[] = [];
                    pieces.forEach((piece, i) => {
                        if (i === tagAt) decipher.setAuthTag(t);
                        out.push(decipher.update(piece));
                    });
                    if (tagAt >= pieces.length) decipher.setAuthTag(t);
                    return attempt(() => {
                        out.push(decipher.final());
                        return Buffer.concat(out).equals(
                            DATA.subarray(0, 1000)
                        );
                    });
                };
                const halves = [
                    encrypted.subarray(0, 500),
                    encrypted.subarray(500)
                ];
                return [
                    encrypted,
                    tag,
                    // one update, tag before it, then after it (ssh2 receiving)
                    decrypt([encrypted], 0),
                    decrypt([encrypted], 1),
                    decrypt(halves, 0),
                    decrypt(halves, 1),
                    decrypt(halves, 2),
                    decrypt([encrypted], 1, Buffer.alloc(16)),
                    decrypt(halves, 2, Buffer.alloc(16))
                ];
            }
        );
    }
    same(
        "aes-256-gcm with a 16-byte IV, a short tag, no data",
        ({ crypto }) => {
            const iv = Buffer.alloc(16, 9);
            const cipher = crypto.createCipheriv("aes-256-gcm", KEY32, iv, {
                authTagLength: 8
            } as any) as any;
            const empty = cipher.final();
            const tag = cipher.getAuthTag();
            const decipher = crypto.createDecipheriv("aes-256-gcm", KEY32, iv, {
                authTagLength: 8
            } as any) as any;
            decipher.setAuthTag(tag);
            return [
                empty,
                tag,
                decipher.final(),
                attempt(() => decipher.final())
            ];
        }
    );
    same("AEAD state errors", ({ crypto }) => {
        const gcm = () =>
            crypto.createCipheriv("aes-128-gcm", KEY16, IV12) as any;
        const gcmDecipher = () =>
            crypto.createDecipheriv("aes-128-gcm", KEY16, IV12) as any;
        const updated = gcm();
        updated.update("x");
        const decipher = gcmDecipher();
        decipher.setAuthTag(Buffer.alloc(16));
        const finished = gcmDecipher();
        finished.update("x");
        return [
            attempt(() => gcm().getAuthTag()),
            attempt(() => updated.setAAD(Buffer.from("late"))),
            attempt(() => decipher.setAuthTag(Buffer.alloc(16))),
            attempt(() => gcmDecipher().setAuthTag(Buffer.alloc(3))),
            attempt(() => finished.final()),
            attempt(() => finished.setAuthTag(Buffer.alloc(16))),
            attempt(() => finished.update("x")),
            attempt(() => finished.final()),
            attempt(() =>
                (
                    crypto.createCipheriv("aes-128-cbc", KEY16, IV16) as any
                ).setAAD(Buffer.alloc(1))
            ),
            attempt(() =>
                (
                    crypto.createDecipheriv("aes-128-cbc", KEY16, IV16) as any
                ).setAuthTag(Buffer.alloc(16))
            ),
            typeof (gcmDecipher() as any).getAuthTag,
            typeof (gcm() as any).setAuthTag
        ];
    });
    same("cipher creation errors", ({ crypto }) =>
        [
            () => crypto.createCipheriv("aes-128-cbc", KEY16, Buffer.alloc(5)),
            () => crypto.createCipheriv("aes-128-cbc", KEY16, null),
            () => crypto.createCipheriv("aes-128-ecb", KEY16, IV16),
            () => crypto.createCipheriv("aes-128-ecb", KEY16, Buffer.alloc(0)),
            () => crypto.createCipheriv("aes-128-gcm", KEY16, Buffer.alloc(0)),
            () => crypto.createCipheriv("aes-128-gcm", KEY16, Buffer.alloc(1)),
            () =>
                crypto.createCipheriv("aes-128-gcm", KEY16, IV12, {
                    authTagLength: 5
                } as any),
            () => crypto.createCipheriv("chacha20-poly1305", KEY32, IV16),
            () =>
                crypto.createCipheriv("chacha20-poly1305", KEY32, IV12, {
                    authTagLength: 17
                } as any),
            () => crypto.createCipheriv("chacha20", KEY32, IV12),
            () =>
                crypto.createCipheriv(
                    "des-cbc",
                    Buffer.alloc(8),
                    Buffer.alloc(8)
                ),
            () => crypto.createCipheriv("aes-128-cbc", 5 as any, IV16),
            () => crypto.createCipheriv("aes-128-cbc", KEY16, 5 as any),
            () => crypto.createCipheriv(5 as any, KEY16, IV16),
            () =>
                crypto.createCipheriv(
                    "aes-128-cbc",
                    crypto.createSecretKey(KEY16),
                    IV16
                ),
            () =>
                crypto.createCipheriv(
                    "aes-128-cbc",
                    crypto.createPublicKey(EC_PUBLIC) as any,
                    IV16
                ),
            () =>
                crypto.createCipheriv(
                    "aes-128-cbc",
                    "0123456789abcdef",
                    "0123456789abcdef"
                )
        ].map((f) => {
            const c = attempt(f);
            return c instanceof Error ||
                (c && typeof c === "object" && "name" in c)
                ? c
                : (c as any).constructor.name;
        })
    );
    same("cipher aliases and modes", ({ crypto }) =>
        [
            ["AES-128-CBC", KEY16, IV16],
            ["aes128", KEY16, IV16],
            ["aes256", KEY32, IV16],
            ["id-aes128-GCM", KEY16, IV12],
            ["des3", KEY24, IV16.subarray(0, 8)],
            ["des-ede3", KEY24, null],
            ["des-ede-cbc", KEY16, IV16.subarray(0, 8)],
            ["aes-192-cfb8", KEY24, IV16],
            ["aes-256-ofb", KEY32, IV16],
            ["aes-192-ctr", KEY24, IV16]
        ].map(([algorithm, key, iv]: any[]) => {
            const c = crypto.createCipheriv(algorithm, key, iv);
            return Buffer.concat([c.update(DATA.subarray(0, 77)), c.final()]);
        })
    );
    same(
        "decrypt in pieces with setAutoPadding(false) and padding",
        ({ crypto }) => {
            const c = crypto.createCipheriv("aes-256-cbc", KEY32, IV16);
            const encrypted = Buffer.concat([
                c.update(DATA.subarray(0, 200)),
                c.final()
            ]);
            const d = crypto.createDecipheriv("aes-256-cbc", KEY32, IV16);
            const parts = [
                d.update(encrypted.subarray(0, 7)),
                d.update(encrypted.subarray(7, 100))
            ];
            d.setAutoPadding(false);
            parts.push(d.update(encrypted.subarray(100)), d.final());
            const noArgument = crypto.createCipheriv(
                "aes-128-cbc",
                KEY16,
                IV16
            );
            noArgument.setAutoPadding();
            noArgument.update(Buffer.alloc(5));
            return [Buffer.concat(parts), attempt(() => noArgument.final())];
        }
    );
    same("update and final with output encodings", ({ crypto }) => {
        const c = crypto.createCipheriv("aes-128-ctr", KEY16, IV16);
        const parts = [
            c.update("aé", "utf8", "base64"),
            c.update("bcdef", "latin1", "base64"),
            c.update(Buffer.from("g"), undefined, "base64"),
            c.final("base64")
        ];
        const d = crypto.createCipheriv("aes-128-cbc", KEY16, IV16);
        return [
            parts,
            d.update("x", "utf8", "hex") + d.final("hex"),
            attempt(() =>
                crypto
                    .createCipheriv("aes-128-cbc", KEY16, IV16)
                    .update("x", "utf8", "nope" as any)
            )
        ];
    });
});

suite("shim crypto - streams", () => {
    same("hash.copy of sha3-256 and shake256", ({ crypto }) => {
        const h = crypto.createHash("sha3-256").update("a");
        const c = h.copy();
        const s = crypto
            .createHash("shake256", { outputLength: 8 })
            .update("x");
        const big = crypto.createHash("blake2b512");
        for (let i = 0; i < 6; i++) big.update(Buffer.alloc(1 << 20, i));
        const bigCopy = big.copy();
        return [
            h.update("b").digest("hex"),
            c.digest("hex"),
            s.copy({ outputLength: 40 }).digest("hex"),
            s.digest("hex"),
            big.digest("hex"),
            bigCopy.update("more").digest("hex"),
            attempt(() => h.copy())
        ];
    });
    same(
        "hash and hmac streams through pipeline",
        async ({ crypto, stream, pipeline }) => {
            const out: unknown[] = [];
            for (const make of [
                () => crypto.createHash("sha3-512"),
                () => crypto.createHash("sha256"),
                () => crypto.createHmac("ripemd160", KEY16),
                () => crypto.createHmac("sha1", KEY16)
            ]) {
                const chunks: Buffer[] = [];
                await pipeline(
                    stream.Readable.from([
                        DATA.subarray(0, 10),
                        "é",
                        DATA.subarray(10)
                    ]),
                    make(),
                    new stream.Writable({
                        write(chunk, _, cb) {
                            chunks.push(chunk);
                            cb();
                        }
                    })
                );
                out.push(Buffer.concat(chunks));
            }
            return out;
        }
    );
    same(
        "cipher streams through pipeline",
        async ({ crypto, stream, pipeline }) => {
            const collect = () => {
                const chunks: Buffer[] = [];
                const sink = new stream.Writable({
                    write(chunk, _, cb) {
                        chunks.push(chunk);
                        cb();
                    }
                });
                return { sink, result: () => Buffer.concat(chunks) };
            };
            const parts = () =>
                stream.Readable.from([
                    DATA.subarray(0, 100),
                    DATA.subarray(100, 1000),
                    "tail"
                ]);
            const out: unknown[] = [];
            for (const [algorithm, key, iv] of [
                ["aes-128-cbc", KEY16, IV16],
                ["aes-128-ctr", KEY16, IV16],
                ["chacha20", KEY32, IV16],
                ["des-ede3-cbc", KEY24, IV16.subarray(0, 8)]
            ] as const) {
                const encrypted = collect();
                await pipeline(
                    parts(),
                    crypto.createCipheriv(algorithm, key, iv),
                    encrypted.sink
                );
                const decrypted = collect();
                await pipeline(
                    stream.Readable.from([encrypted.result()]),
                    crypto.createDecipheriv(algorithm, key, iv),
                    decrypted.sink
                );
                out.push(
                    encrypted.result(),
                    decrypted.result().toString().slice(-8)
                );
            }
            const gcm = crypto.createCipheriv("aes-256-gcm", KEY32, IV12);
            const sealed = collect();
            await pipeline(parts(), gcm, sealed.sink);
            out.push(sealed.result(), gcm.getAuthTag());
            // a wrong padding fails the pipeline
            const bad = crypto.createDecipheriv("aes-128-cbc", KEY16, IV16);
            out.push(
                await pipeline(
                    stream.Readable.from([Buffer.alloc(16, 1)]),
                    bad,
                    collect().sink
                ).then(
                    () => "ok",
                    (e) => errorShape(e)
                )
            );
            return out;
        }
    );
    same(
        "Sign and Verify as writable streams",
        async ({ crypto, stream, pipeline }) => {
            const signer = crypto.createSign("sha384");
            await pipeline(
                stream.Readable.from([DATA.subarray(0, 10), DATA.subarray(10)]),
                signer
            );
            const signature = signer.sign(RSA_PRIVATE, "hex");
            const verifier = crypto.createVerify("RSA-SHA384");
            verifier.write(DATA.subarray(0, 500));
            verifier.end(DATA.subarray(500));
            return [signature, verifier.verify(RSA_PUBLIC, signature, "hex")];
        }
    );
});

suite("shim crypto - keys", () => {
    same(
        "generateKeyPairSync with PEM encodings and a passphrase",
        ({ crypto }) => {
            const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
                namedCurve: "P-384",
                publicKeyEncoding: { type: "spki", format: "pem" },
                privateKeyEncoding: {
                    type: "pkcs8",
                    format: "pem",
                    cipher: "aes-256-cbc",
                    passphrase: "top secret"
                }
            });
            const nodeKey = nodeCrypto.createPrivateKey({
                key: privateKey,
                passphrase: "top secret"
            });
            const signature = nodeCrypto.sign("sha384", DATA, nodeKey);
            const ours = crypto.createPrivateKey({
                key: privateKey,
                passphrase: "top secret"
            });
            return [
                typeof publicKey,
                privateKey.split("\n")[0],
                crypto.verify("sha384", DATA, publicKey, signature),
                nodeCrypto.verify(
                    "sha384",
                    DATA,
                    publicKey,
                    crypto.sign("sha384", DATA, ours)
                ),
                ours.asymmetricKeyDetails,
                attempt(() => crypto.createPrivateKey(privateKey)),
                attempt(() =>
                    crypto.createPrivateKey({
                        key: privateKey,
                        passphrase: "wrong"
                    })
                )
            ];
        }
    );
    same(
        "generateKeyPairSync rsa with legacy PEM encryption and DER",
        ({ crypto, Buffer }) => {
            const { publicKey, privateKey } = crypto.generateKeyPairSync(
                "rsa",
                {
                    modulusLength: 1024,
                    publicExponent: 3,
                    publicKeyEncoding: { type: "pkcs1", format: "der" },
                    privateKeyEncoding: {
                        type: "pkcs1",
                        format: "pem",
                        cipher: "des-ede3-cbc",
                        passphrase: Buffer.from("pw")
                    }
                }
            ) as any;
            const key = nodeCrypto.createPrivateKey({
                key: privateKey,
                passphrase: "pw"
            });
            const pub = crypto.createPublicKey({
                key: publicKey,
                format: "der",
                type: "pkcs1"
            });
            return [
                Buffer.isBuffer(publicKey),
                privateKey.split("\n").slice(0, 2),
                key.asymmetricKeyDetails,
                pub.asymmetricKeyDetails,
                crypto.verify(
                    "sha256",
                    DATA,
                    pub,
                    nodeCrypto.sign("sha256", DATA, key)
                )
            ];
        }
    );
    same("generateKeyPairSync encoding errors", ({ crypto }) =>
        [
            () => crypto.generateKeyPairSync("rsa" as any),
            () => crypto.generateKeyPairSync("rsa", {} as any),
            () => crypto.generateKeyPairSync("ec", {} as any),
            () => crypto.generateKeyPairSync("ec", { namedCurve: "nope" }),
            () => crypto.generateKeyPairSync("nope" as any, {}),
            () =>
                crypto.generateKeyPairSync("ed25519", {
                    publicKeyEncoding: { type: "spki", format: "nope" }
                } as any),
            () =>
                crypto.generateKeyPairSync("ed25519", {
                    publicKeyEncoding: { format: "pem" }
                } as any),
            () =>
                crypto.generateKeyPairSync("ed25519", {
                    publicKeyEncoding: "x"
                } as any),
            () =>
                crypto.generateKeyPairSync("ed25519", {
                    privateKeyEncoding: {
                        format: "pem",
                        type: "pkcs8",
                        cipher: "aes-128-cbc"
                    }
                } as any),
            () =>
                crypto.generateKeyPairSync("ed25519", {
                    privateKeyEncoding: { format: "pem", type: "pkcs1" }
                } as any),
            () =>
                crypto.generateKeyPairSync("ec", {
                    namedCurve: "P-256",
                    privateKeyEncoding: {
                        format: "der",
                        type: "sec1",
                        cipher: "aes-128-cbc",
                        passphrase: "x"
                    }
                } as any)
        ].map(attempt)
    );
    same("generateKeyPairSync rsa-pss and ec details", ({ crypto }) => {
        const pss: any = crypto.generateKeyPairSync("rsa-pss", {
            modulusLength: 1024,
            hashAlgorithm: "sha256",
            saltLength: 16
        } as any);
        const ecKey: any = crypto.generateKeyPairSync("ec", {
            namedCurve: "secp256k1"
        });
        return [
            pss.publicKey.asymmetricKeyType,
            pss.privateKey.asymmetricKeyDetails,
            ecKey.publicKey.asymmetricKeyDetails,
            crypto.generateKeyPairSync("x448").privateKey.asymmetricKeyDetails,
            crypto
                .generateKeyPairSync("ed448")
                .publicKey.export({ format: "der", type: "spki" }).length
        ];
    });
    same("generateKeyPair callback and promisify", async ({ crypto }) => {
        const [pub, priv] = await new Promise<any[]>((resolve, reject) =>
            crypto.generateKeyPair(
                "ec",
                {
                    namedCurve: "prime256v1",
                    publicKeyEncoding: { type: "spki", format: "der" },
                    privateKeyEncoding: { type: "sec1", format: "pem" }
                },
                (e, a, b) => (e ? reject(e) : resolve([a, b]))
            )
        );
        const pair: any = await promisify(crypto.generateKeyPair)("x25519", {});
        return [
            pub.length,
            priv.split("\n")[0],
            pair.publicKey.type,
            pair.privateKey.asymmetricKeyType,
            attempt(() => crypto.generateKeyPair("ed25519", {}, undefined))
        ];
    });
    same("generateKeySync and generateKey", async ({ crypto }) => {
        const hmac = crypto.generateKeySync("hmac", { length: 100 });
        const aes = await callback<any>((cb) =>
            crypto.generateKey("aes", { length: 192 }, cb)
        );
        return [
            hmac.symmetricKeySize,
            aes.symmetricKeySize,
            aes.type,
            attempt(() => crypto.generateKeySync("hmac", { length: 7 })),
            attempt(() => crypto.generateKeySync("aes", { length: 100 })),
            attempt(() =>
                crypto.generateKeySync("nope" as any, { length: 100 })
            ),
            attempt(() => (crypto.generateKeySync as any)("aes"))
        ];
    });
    same("KeyObject equals", ({ crypto, Buffer }) => {
        const pub = crypto.createPublicKey(RSA_PUBLIC);
        const derived = crypto.createPublicKey(RSA_PRIVATE);
        const pkcs1 = crypto.createPrivateKey(RSA_PRIVATE_PKCS1);
        const pkcs8 = crypto.createPrivateKey(RSA_PRIVATE);
        const secret = crypto.createSecretKey(KEY16);
        return [
            pub.equals(derived),
            pkcs1.equals(pkcs8),
            pub.equals(pkcs8),
            crypto.createPublicKey(RSA_PUBLIC_PKCS1).equals(pub),
            secret.equals(crypto.createSecretKey(Buffer.from(KEY16))),
            secret.equals(crypto.createSecretKey(KEY32)),
            secret.equals(pub),
            attempt(() => pub.equals("x" as any)),
            Object.keys(pub),
            pub instanceof crypto.KeyObject
        ];
    });
    same("KeyObject export of each type", ({ crypto }) => {
        const rsaPublic = crypto.createPublicKey(RSA_PUBLIC);
        const rsaPrivate = crypto.createPrivateKey(RSA_PRIVATE);
        const ecPublic = crypto.createPublicKey(EC_PUBLIC);
        const ecPrivate = crypto.createPrivateKey({
            key: EC_PRIVATE_PKCS8,
            format: "der",
            type: "pkcs8"
        });
        const edPrivate = crypto.createPrivateKey({
            key: ED25519_PRIVATE,
            format: "der",
            type: "pkcs8"
        });
        const xPrivate = crypto.createPrivateKey({
            key: X25519_PRIVATE,
            format: "der",
            type: "pkcs8"
        });
        return [
            rsaPublic.export({ type: "pkcs1", format: "pem" }),
            rsaPublic.export({ type: "spki", format: "der" }),
            rsaPublic.export({ format: "jwk" }),
            rsaPrivate.export({ type: "pkcs1", format: "der" }),
            rsaPrivate.export({ type: "pkcs8", format: "pem" }),
            rsaPrivate.export({ format: "jwk" }),
            ecPublic.export({ type: "spki", format: "pem" }),
            ecPrivate.export({ type: "sec1", format: "pem" }),
            ecPrivate.export({ format: "jwk" }),
            edPrivate.export({ type: "pkcs8", format: "pem" }),
            edPrivate.export({ format: "jwk" }),
            crypto
                .createPublicKey(edPrivate)
                .export({ type: "spki", format: "der" }),
            xPrivate.export({ format: "jwk" }),
            crypto.createPublicKey(xPrivate).export({ format: "jwk" }),
            [
                rsaPublic,
                rsaPrivate,
                ecPublic,
                ecPrivate,
                edPrivate,
                xPrivate
            ].map((k) => [
                k.type,
                k.asymmetricKeyType,
                k.asymmetricKeyDetails,
                (k as any).symmetricKeySize
            ])
        ];
    });
    same("KeyObject export errors", ({ crypto }) => {
        const rsaPublic = crypto.createPublicKey(RSA_PUBLIC);
        const ecPrivate = crypto.createPrivateKey(EC_PRIVATE);
        const edPrivate = crypto.createPrivateKey({
            key: ED25519_PRIVATE,
            format: "der",
            type: "pkcs8"
        });
        return [
            () => (rsaPublic as any).export(),
            () => rsaPublic.export({ format: "pem" } as any),
            () => rsaPublic.export({ format: "pem", type: "pkcs8" } as any),
            () => rsaPublic.export({ format: "nope", type: "spki" } as any),
            () =>
                crypto
                    .createPublicKey(EC_PUBLIC)
                    .export({ format: "pem", type: "pkcs1" }),
            () => ecPrivate.export({ format: "pem" } as any),
            () => edPrivate.export({ format: "pem", type: "sec1" }),
            () =>
                edPrivate.export({
                    format: "pem",
                    type: "pkcs8",
                    cipher: "aes-256-cbc"
                } as any),
            () =>
                edPrivate.export({
                    format: "pem",
                    type: "pkcs8",
                    cipher: "nope",
                    passphrase: "x"
                }),
            () =>
                ecPrivate.export({
                    format: "der",
                    type: "sec1",
                    cipher: "aes-128-cbc",
                    passphrase: "x"
                })
        ].map(attempt);
    });
    same("key inputs: JWK, DER types, KeyObjects", ({ crypto }) => {
        const jwk = ec.publicKey.export({ format: "jwk" });
        const privateJwk = ec.privateKey.export({ format: "jwk" });
        return [
            crypto
                .createPublicKey({ key: jwk, format: "jwk" })
                .export({ type: "spki", format: "pem" }),
            crypto.createPrivateKey({ key: privateJwk, format: "jwk" })
                .asymmetricKeyDetails,
            crypto.createPublicKey({ key: privateJwk, format: "jwk" }).type,
            crypto.createPrivateKey({
                key: ec.privateKey.export({ type: "sec1", format: "der" }),
                format: "der",
                type: "sec1"
            }).asymmetricKeyType,
            crypto.createPublicKey({ key: RSA_PUBLIC_PKCS1, type: "pkcs1" })
                .asymmetricKeyDetails,
            crypto.createPublicKey(crypto.createPrivateKey(EC_PRIVATE)).type,
            attempt(() =>
                crypto.createPublicKey(crypto.createPublicKey(EC_PUBLIC))
            ),
            attempt(() =>
                crypto.createPrivateKey(
                    crypto.createPrivateKey(EC_PRIVATE) as any
                )
            ),
            attempt(() =>
                crypto.createPublicKey(crypto.createSecretKey(KEY16))
            ),
            attempt(() =>
                crypto.createPublicKey({
                    key: ec.publicKey.export({ type: "spki", format: "der" }),
                    format: "der"
                } as any)
            ),
            attempt(() =>
                crypto.createPublicKey({ key: "x", format: "nope" } as any)
            ),
            attempt(() => crypto.createPublicKey(5 as any)),
            attempt(() => crypto.createPrivateKey(EC_PUBLIC)),
            attempt(() => crypto.createPrivateKey("garbage")),
            attempt(() =>
                crypto.createPrivateKey({
                    key: rsa.privateKey.export({
                        type: "pkcs8",
                        format: "der",
                        cipher: "aes-128-cbc",
                        passphrase: "pw"
                    }),
                    format: "der",
                    type: "pkcs8"
                })
            ),
            crypto
                .createPrivateKey({
                    key: rsa.privateKey.export({
                        type: "pkcs8",
                        format: "der",
                        cipher: "aes-128-cbc",
                        passphrase: "pw"
                    }),
                    format: "der",
                    type: "pkcs8",
                    passphrase: "pw"
                })
                .equals(crypto.createPrivateKey(RSA_PRIVATE))
        ];
    });
    same("createSecretKey export forms", ({ crypto }) => {
        const key = crypto.createSecretKey("00ff7f", "hex");
        return [
            key.type,
            key.symmetricKeySize,
            key.asymmetricKeyType,
            key.export(),
            key.export({ format: "buffer" }),
            key.export({ format: "jwk" }),
            attempt(() => key.export({ format: "pem" } as any)),
            attempt(() => crypto.createSecretKey(5 as any)),
            crypto.createHmac("sha256", key).update("x").digest("hex"),
            crypto
                .createCipheriv(
                    "aes-128-ecb",
                    crypto.createSecretKey(KEY16),
                    null
                )
                .update(KEY16)
        ];
    });
});

suite("shim crypto - signatures and agreement", () => {
    same("sign and verify callbacks", async ({ crypto }) => {
        const rsaSig = await callback<Buffer>((cb) =>
            crypto.sign("sha256", DATA, RSA_PRIVATE, cb)
        );
        const ok = await callback<boolean>((cb) =>
            crypto.verify("sha256", DATA, RSA_PUBLIC, rsaSig, cb)
        );
        const bad = await callback<boolean>((cb) =>
            crypto.verify("sha256", DATA.subarray(1), RSA_PUBLIC, rsaSig, cb)
        );
        const ecSig = await callback<Buffer>((cb) =>
            crypto.sign(
                "sha512",
                DATA,
                { key: EC_PRIVATE, dsaEncoding: "ieee-p1363" },
                cb
            )
        );
        const edSig = await callback<Buffer>((cb) =>
            crypto.sign(
                undefined,
                DATA,
                { key: ED25519_PRIVATE, format: "der", type: "pkcs8" },
                cb
            )
        );
        return [
            rsaSig,
            ok,
            bad,
            nodeCrypto.verify(
                "sha512",
                DATA,
                { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
                ecSig
            ),
            edSig
        ];
    });
    same("sign callback errors are thrown", ({ crypto }) =>
        [
            () => crypto.sign(null, DATA, "garbage", () => {}),
            () =>
                crypto.sign(
                    null,
                    DATA,
                    crypto.createPublicKey(EC_PUBLIC),
                    () => {}
                ),
            () => crypto.sign("nope", DATA, RSA_PRIVATE, () => {}),
            () => crypto.sign("sha256", DATA, RSA_PRIVATE, 5 as any),
            () => crypto.sign(null, DATA, undefined),
            () => crypto.sign(null, 5 as any, RSA_PRIVATE),
            () => crypto.sign(5 as any, DATA, RSA_PRIVATE),
            () =>
                crypto.sign(
                    "sha256",
                    DATA,
                    crypto.createPrivateKey({
                        key: ED25519_PRIVATE,
                        format: "der",
                        type: "pkcs8"
                    })
                ),
            () => crypto.verify(null, DATA, EC_PUBLIC, 5 as any),
            () => crypto.createSign("nope"),
            () => {
                const signer = crypto.createSign("sha256").update(DATA);
                signer.sign(EC_PRIVATE);
                return signer.sign(EC_PRIVATE);
            }
        ].map(attempt)
    );
    same("RSA-PSS and PKCS#1 options, string data", ({ crypto }) => {
        const pss = crypto.sign("sha256", "text", {
            key: RSA_PRIVATE,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 20
        });
        return [
            nodeCrypto.verify(
                "sha256",
                Buffer.from("text"),
                {
                    key: rsa.publicKey,
                    padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 20
                },
                pss
            ),
            crypto.verify(
                "RSA-SHA256",
                Buffer.from("text"),
                {
                    key: RSA_PUBLIC,
                    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 20
                },
                pss
            ),
            crypto.sign("sha1WithRSAEncryption", DATA, RSA_PRIVATE_PKCS1),
            attempt(() =>
                crypto.sign("sha256", DATA, { key: RSA_PRIVATE, padding: 1.5 })
            ),
            attempt(() =>
                crypto.sign("sha256", DATA, {
                    key: EC_PRIVATE,
                    dsaEncoding: "nope"
                } as any)
            )
        ];
    });
    for (const curve of ["secp256k1", "secp521r1", "secp224r1"]) {
        same(
            `ECDSA ${curve} sign verifies in Node, verify of a Node signature`,
            ({ crypto }) => {
                const pair = nodeCrypto.generateKeyPairSync("ec", {
                    namedCurve: curve
                });
                const privatePem = pair.privateKey.export({
                    type: "pkcs8",
                    format: "pem"
                });
                const publicPem = pair.publicKey.export({
                    type: "spki",
                    format: "pem"
                });
                return [
                    nodeCrypto.verify(
                        "sha256",
                        DATA,
                        pair.publicKey,
                        crypto.sign("sha256", DATA, privatePem)
                    ),
                    crypto.verify(
                        "sha256",
                        DATA,
                        publicPem,
                        nodeCrypto.sign("sha256", DATA, pair.privateKey)
                    ),
                    crypto.createPublicKey(publicPem).asymmetricKeyDetails
                ];
            }
        );
    }
    same(
        "RSA encryption: paddings, OAEP hash and label, errors",
        ({ crypto }) => {
            const label = Buffer.from("label");
            const oaep = crypto.publicEncrypt(
                { key: RSA_PUBLIC, oaepHash: "sha256", oaepLabel: label },
                "secret"
            );
            const pkcs1 = crypto.publicEncrypt(
                {
                    key: RSA_PUBLIC,
                    padding: crypto.constants.RSA_PKCS1_PADDING
                },
                Buffer.from("x")
            );
            return [
                nodeCrypto
                    .privateDecrypt(
                        {
                            key: rsa.privateKey,
                            oaepHash: "sha256",
                            oaepLabel: label
                        },
                        oaep
                    )
                    .toString(),
                crypto
                    .privateDecrypt(
                        {
                            key: RSA_PRIVATE,
                            oaepHash: "sha256",
                            oaepLabel: label
                        },
                        oaep
                    )
                    .toString(),
                nodeCrypto
                    .privateDecrypt(
                        {
                            key: rsa.privateKey,
                            padding: nodeCrypto.constants.RSA_PKCS1_PADDING
                        },
                        pkcs1
                    )
                    .toString(),
                crypto
                    .publicDecrypt(
                        RSA_PUBLIC,
                        crypto.privateEncrypt(
                            RSA_PRIVATE,
                            Buffer.from("signed")
                        )
                    )
                    .toString(),
                crypto.privateEncrypt(
                    RSA_PRIVATE_PKCS1,
                    Buffer.from("deterministic")
                ),
                crypto.publicEncrypt(
                    crypto.createPrivateKey(RSA_PRIVATE),
                    Buffer.from("x")
                ).length,
                attempt(() =>
                    crypto.publicEncrypt(RSA_PUBLIC, Buffer.alloc(300))
                ),
                attempt(() =>
                    crypto.privateDecrypt(RSA_PRIVATE, Buffer.alloc(256, 1))
                ),
                attempt(() =>
                    crypto.privateDecrypt(
                        crypto.createPublicKey(RSA_PUBLIC) as any,
                        Buffer.alloc(256)
                    )
                ),
                attempt(() =>
                    crypto.publicEncrypt(
                        { key: RSA_PUBLIC, oaepHash: "nope" },
                        Buffer.from("x")
                    )
                ),
                attempt(() =>
                    crypto.publicEncrypt(
                        { key: RSA_PUBLIC, oaepHash: 5 } as any,
                        Buffer.from("x")
                    )
                ),
                attempt(() => crypto.publicEncrypt(RSA_PUBLIC, 5 as any))
            ];
        }
    );
    same(
        "diffieHellman with EC keys, callback and errors",
        async ({ crypto }) => {
            const a = nodeCrypto.generateKeyPairSync("ec", {
                namedCurve: "secp384r1"
            });
            const b = nodeCrypto.generateKeyPairSync("ec", {
                namedCurve: "secp384r1"
            });
            const privateKey = crypto.createPrivateKey(
                a.privateKey.export({ type: "sec1", format: "pem" })
            );
            const publicKey = crypto.createPublicKey(
                b.publicKey.export({ type: "spki", format: "pem" })
            );
            const expected = nodeCrypto.diffieHellman({
                privateKey: a.privateKey,
                publicKey: b.publicKey
            });
            const viaCallback = await callback<Buffer>((cb) =>
                (crypto.diffieHellman as any)({ privateKey, publicKey }, cb)
            );
            const x = crypto.createPrivateKey({
                key: X25519_PRIVATE,
                format: "der",
                type: "pkcs8"
            });
            return [
                crypto
                    .diffieHellman({ privateKey, publicKey })
                    .equals(expected),
                Buffer.from(viaCallback).equals(expected),
                crypto.diffieHellman({ privateKey: x, publicKey: x }).length,
                attempt(() =>
                    crypto.diffieHellman({
                        privateKey: "x",
                        publicKey: "y"
                    } as any)
                ),
                attempt(() =>
                    crypto.diffieHellman({ privateKey: x, publicKey })
                ),
                attempt(() =>
                    crypto.diffieHellman({
                        privateKey: publicKey,
                        publicKey
                    } as any)
                ),
                attempt(() => (crypto.diffieHellman as any)())
            ];
        }
    );
    same("ECDH.convertKey and point formats", ({ crypto, Buffer }) => {
        const ecdh = crypto.createECDH("prime256v1");
        ecdh.setPrivateKey(Buffer.alloc(32, 3));
        const compressed = ecdh.getPublicKey("hex", "compressed");
        return [
            compressed,
            ecdh.getPublicKey(null, "hybrid"),
            ecdh.getPublicKey("base64"),
            crypto.ECDH.convertKey(
                compressed,
                "prime256v1",
                "hex",
                "base64",
                "uncompressed"
            ),
            crypto.ECDH.convertKey(
                ecdh.getPublicKey(),
                "prime256v1",
                undefined,
                "hex",
                "compressed"
            ),
            crypto.ECDH.convertKey(
                compressed,
                "prime256v1",
                "hex",
                undefined,
                "hybrid"
            ),
            attempt(() => crypto.ECDH.convertKey(ecdh.getPublicKey(), "nope")),
            attempt(() =>
                crypto.ECDH.convertKey(Buffer.alloc(33, 2), "prime256v1")
            ),
            attempt(() => ecdh.getPublicKey(null, "nope" as any))
        ];
    });
    same("ECDH keys and errors", ({ crypto, Buffer }) => {
        const fresh = () => crypto.createECDH("secp256k1");
        const small = fresh();
        small.setPrivateKey(Buffer.from([5]));
        const padded = fresh();
        padded.setPrivateKey(
            Buffer.concat([Buffer.alloc(31), Buffer.from([5])])
        );
        const generated = fresh();
        const pub = generated.generateKeys();
        return [
            small.getPrivateKey(),
            padded.getPrivateKey("hex"),
            small.getPublicKey().equals(padded.getPublicKey()),
            pub.length,
            generated
                .computeSecret(small.getPublicKey())
                .equals(small.computeSecret(pub)),
            attempt(() => fresh().getPublicKey()),
            attempt(() => fresh().getPrivateKey()),
            attempt(() => fresh().computeSecret(pub)),
            attempt(() => fresh().setPrivateKey(Buffer.alloc(32))),
            attempt(() => generated.computeSecret(Buffer.alloc(65, 1))),
            attempt(() => crypto.createECDH("P-256")),
            attempt(() => crypto.createECDH("nope"))
        ];
    });
    same("DiffieHellman getters and setters", ({ crypto, Buffer }) => {
        const prime = Buffer.from(
            nodeCrypto.getDiffieHellman("modp2").getPrime()
        );
        const dh = crypto.createDiffieHellman(prime, Buffer.from([2]));
        const before = [
            attempt(() => dh.getPublicKey()),
            attempt(() => dh.getPrivateKey())
        ];
        dh.setPrivateKey(Buffer.alloc(16, 5));
        before.push(attempt(() => dh.getPublicKey()));
        const pub = dh.generateKeys("hex");
        const again = dh.generateKeys("hex");
        const other = crypto.createDiffieHellman(
            prime.toString("hex"),
            "hex",
            "02",
            "hex"
        );
        other.setPrivateKey(Buffer.alloc(16, 6));
        other.generateKeys();
        const secret = dh.computeSecret(
            other.getPublicKey("base64"),
            "base64",
            "hex"
        );
        dh.setPublicKey(Buffer.from([1, 2, 3]));
        return [
            before,
            pub,
            again === pub,
            dh.getPrivateKey("hex"),
            dh.getPublicKey("hex"),
            dh.getPrime("base64"),
            dh.getGenerator(),
            other.getGenerator("hex"),
            dh.verifyError,
            secret === other.computeSecret(pub, "hex", "hex"),
            attempt(() => dh.computeSecret(Buffer.from([1]))),
            crypto.createDiffieHellman(prime, 5).getGenerator(),
            attempt(() => crypto.createDiffieHellman(prime, Buffer.from([1]))),
            attempt(() => crypto.createDiffieHellman(prime, 1)),
            attempt(() => crypto.createDiffieHellman({} as any)),
            attempt(() => crypto.getDiffieHellman("modp3")),
            typeof (crypto.getDiffieHellman("modp5") as any).setPrivateKey,
            crypto.getDiffieHellman("modp1").getPrime().length,
            Object.keys(dh)
        ];
    });
});

suite("shim crypto - key derivation, random and misc", () => {
    same("pbkdf2 callback and errors", async ({ crypto }) => {
        const key = await callback<Buffer>((cb) =>
            crypto.pbkdf2("password", "salt", 2, 20, "RSA-SHA256", cb)
        );
        return [
            key,
            crypto.pbkdf2Sync(
                Buffer.from("pw"),
                new Uint16Array([1, 2]),
                3,
                64,
                "sha3-256"
            ),
            ...[
                () => crypto.pbkdf2Sync("a", "b", 1, 1, "nope"),
                () => crypto.pbkdf2("a", "b", 1, 1, "nope", () => {}),
                () => (crypto.pbkdf2Sync as any)("a", "b", 1, 1),
                () => crypto.pbkdf2Sync("a", "b", 0, 1, "sha1"),
                () => crypto.pbkdf2Sync("a", "b", 1, -1, "sha1"),
                () => crypto.pbkdf2Sync("a", "b", 1, 0, "sha1"),
                () => (crypto.pbkdf2 as any)("a", "b", 1, 1, "sha1"),
                () => crypto.pbkdf2Sync(5 as any, "b", 1, 1, "sha1"),
                () => crypto.pbkdf2Sync("a", "b", 1, 4, "shake128")
            ].map(attempt)
        ];
    });
    same("scrypt callback and errors", async ({ crypto }) => {
        const key = await callback<Buffer>((cb) =>
            crypto.scrypt(
                "password",
                "salt",
                24,
                { cost: 32, blockSize: 4, parallelization: 2 },
                cb
            )
        );
        const noOptions = await callback<Buffer>((cb) =>
            crypto.scrypt("pw", "salt", 8, cb as any)
        );
        return [
            key,
            noOptions,
            crypto.scryptSync("pw", "salt", 0),
            crypto.scryptSync("pw", "salt", 16, { N: 16, maxmem: 0 }),
            ...[
                () => crypto.scryptSync("a", "b", 4, { N: 3 }),
                () => crypto.scrypt("a", "b", 4, { N: 3 }, () => {}),
                () => crypto.scryptSync("a", "b", 4, { N: 16, cost: 16 }),
                () => crypto.scryptSync("a", "b", 4, { N: 1 << 20 }),
                () => crypto.scryptSync("a", "b", 4, { N: "16" } as any),
                () => crypto.scryptSync("a", "b", 4, { r: 1, p: 2 ** 30 }),
                () => crypto.scryptSync("a", "b", -1),
                () => crypto.scrypt("a", "b", 4, {}, undefined)
            ].map(attempt)
        ];
    });
    same("hkdf callback and errors", async ({ crypto }) => {
        const key = await callback<ArrayBuffer>((cb) =>
            crypto.hkdf("sha512", "ikm", "salt", "info", 100, cb)
        );
        return [
            key,
            crypto.hkdfSync(
                "sha3-256",
                crypto.createSecretKey(KEY16),
                Buffer.alloc(0),
                "",
                64
            ),
            ...[
                () => crypto.hkdfSync("nope", "k", "s", "i", 4),
                () => crypto.hkdf("nope", "k", "s", "i", 4, () => {}),
                () => crypto.hkdfSync("sha256", "k", "s", "i", 255 * 32 + 1),
                () =>
                    crypto.hkdf(
                        "sha256",
                        "k",
                        "s",
                        "i",
                        255 * 32 + 1,
                        () => {}
                    ),
                () =>
                    crypto.hkdfSync("sha256", "k", "s", Buffer.alloc(1025), 4),
                () => crypto.hkdfSync("sha256", 5 as any, "s", "i", 4),
                () => crypto.hkdfSync("sha256", "k", 5 as any, "i", 4),
                () => crypto.hkdfSync("sha256", "k", "s", "i", -1),
                () => crypto.hkdfSync(5 as any, "k", "s", "i", 4),
                () => (crypto.hkdf as any)("sha256", "k", "s", "i", 4)
            ].map(attempt)
        ];
    });
    same("randomInt ranges and errors", async ({ crypto }) => {
        const values = Array.from({ length: 300 }, () =>
            crypto.randomInt(-3, 3)
        );
        const viaCallback = await callback<number>((cb) =>
            crypto.randomInt(10, cb)
        );
        const big = crypto.randomInt(2 ** 48 - 2, 2 ** 48 - 1);
        return [
            values.every((v) => Number.isInteger(v) && v >= -3 && v < 3),
            new Set(values).size,
            crypto.randomInt(1),
            viaCallback >= 0 && viaCallback < 10,
            big,
            ...[
                () => crypto.randomInt(0),
                () => crypto.randomInt(1.5),
                () => crypto.randomInt(5, 3),
                () => crypto.randomInt(0, 2 ** 48),
                () => crypto.randomInt(-1, 2 ** 48 - 1),
                () => crypto.randomInt("5" as any),
                () => crypto.randomInt(1, 5, 5 as any)
            ].map(attempt)
        ];
    });
    same(
        "randomBytes, randomFill and randomFillSync ranges",
        async ({ crypto }) => {
            const u32 = crypto.randomFillSync(new Uint32Array(4), 1, 2);
            const filled = await callback<Uint8Array>((cb) =>
                crypto.randomFill(new Uint8Array(70000), 69990, cb as any)
            );
            return [
                [u32[0], u32[3]],
                crypto.randomFillSync(new ArrayBuffer(4)).byteLength,
                crypto.randomBytes(100000).length,
                crypto.randomBytes(1.5).length,
                filled.subarray(0, 69990).every((b) => b === 0),
                ...[
                    () => crypto.randomBytes(-1),
                    () => crypto.randomBytes("1" as any),
                    () => crypto.randomBytes(2 ** 31),
                    () => crypto.randomBytes(1, 5 as any),
                    () => crypto.randomFillSync("x" as any),
                    () => crypto.randomFillSync(Buffer.alloc(4), 5),
                    () => crypto.randomFillSync(Buffer.alloc(4), 1, 4),
                    () => (crypto.randomFill as any)(Buffer.alloc(4)),
                    () => crypto.randomUUID({ disableEntropyCache: 5 } as any)
                ].map(attempt)
            ];
        }
    );
    same("timingSafeEqual argument errors and views", ({ crypto }) =>
        [
            () => crypto.timingSafeEqual("a" as any, "a" as any),
            () => crypto.timingSafeEqual(Buffer.alloc(1), "a" as any),
            () =>
                crypto.timingSafeEqual(
                    new Uint16Array([1, 2]),
                    Buffer.from([1, 0, 2, 0])
                ),
            () =>
                crypto.timingSafeEqual(new ArrayBuffer(2), new ArrayBuffer(2)),
            () =>
                crypto.timingSafeEqual(
                    new DataView(new ArrayBuffer(3)),
                    new Uint8Array(2)
                )
        ].map(attempt)
    );
    same("hash names, lengths and finalized states", ({ crypto }) => [
        ...[
            "RSA-SHA256",
            "sha256WithRSAEncryption",
            "SHA-256",
            "SHA512",
            "RSA-SHA512/256",
            "rmd160",
            "ssl3-md5",
            "id-rsassa-pkcs1-v1_5-with-sha3-384",
            "blake2s256"
        ].map((name) => crypto.createHash(name).update("x").digest("base64")),
        crypto.createHash("shake128", { outputLength: 5 }).digest("hex"),
        crypto.createHash("sha256", { outputLength: 32 }).digest("hex"),
        crypto.createHash("sha1").digest("nope" as any),
        crypto
            .createHmac("sha1", "k")
            .update("ab", "nope" as any)
            .digest("hex"),
        crypto.hash("sha1", Buffer.from("x"), "buffer"),
        crypto.hash("sha3-224", "x", "base64url"),
        ...[
            () => crypto.createHash("sha256", { outputLength: 5 }),
            () => crypto.createHash("sha1").update("abc", "hex"),
            () => crypto.createHash("sha1").update(5 as any),
            () => {
                const h = crypto.createHash("sha256");
                h.digest();
                return h.update("a");
            },
            () => {
                const h = crypto.createHmac("sha256", "k");
                h.digest();
                return [h.digest("hex"), h.digest()];
            },
            () => {
                const h = crypto.createHmac("sha256", "k");
                h.digest();
                return h.update("a");
            },
            () => crypto.createHmac("nope", "k"),
            () => crypto.createHmac("sha256", null as any),
            () => crypto.hash("nope", "x"),
            () => crypto.hash("sha1", 5 as any),
            () => crypto.hash("sha1", "x", "nope" as any)
        ].map(attempt)
    ]);
    same(
        "getCiphers, getHashes and getCurves cover what ssh2 checks",
        ({ crypto }) => [
            [
                "aes128-ctr",
                "aes-128-ctr",
                "aes-192-ctr",
                "aes-256-ctr",
                "aes-128-gcm",
                "aes-256-gcm",
                "aes-128-cbc",
                "aes-192-cbc",
                "aes-256-cbc",
                "des-ede3-cbc",
                "chacha20",
                "chacha20-poly1305",
                "id-aes256-gcm"
            ].map((c) => crypto.getCiphers().includes(c)),
            [
                "sha1",
                "sha256",
                "sha512",
                "md5",
                "RSA-SHA1",
                "sha256WithRSAEncryption"
            ].map((h) => crypto.getHashes().includes(h)),
            crypto
                .getCurves()
                .filter((c) =>
                    ["prime256v1", "secp384r1", "secp521r1"].includes(c)
                )
        ]
    );
    same("constants, fips and webcrypto", ({ crypto }) => [
        crypto.constants.POINT_CONVERSION_HYBRID,
        crypto.constants.RSA_PSS_SALTLEN_AUTO,
        typeof crypto.constants.defaultCipherList,
        crypto.getFips(),
        crypto.webcrypto === globalThis.crypto,
        crypto.subtle === globalThis.crypto.subtle,
        crypto.getRandomValues(new Uint8Array(4)).length,
        attempt(() => crypto.getRandomValues(new Uint8Array(65537)))
    ]);
});
