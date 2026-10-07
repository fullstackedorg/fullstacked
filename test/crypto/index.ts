import test, { suite } from "node:test";
import assert from "node:assert";
import nodeCrypto from "node:crypto";
import crypto from "../../core/internal/bundle/lib/crypto/index.ts";

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
        key: Buffer.concat([hex("302e020100300506032b657004220420"), hex(seed)]),
        format: "der",
        type: "pkcs8"
    });

suite("crypto - ed25519", () => {
    test("RFC 8032 vectors: public key, sign and verify", () => {
        for (const [seed, pub, msg, sig] of RFC8032) {
            const privateKey = privateFromSeed(seed);
            const publicKey = crypto.createPublicKey(privateKey);
            assert.equal(publicKey.export({ format: "jwk" }).x, hex(pub).toString("base64url"));
            assert.equal(crypto.sign(null, hex(msg), privateKey).toString("hex"), sig);
            assert.equal(crypto.verify(null, hex(msg), publicKey, hex(sig)), true);
        }
    });

    test("interoperates with node:crypto keys and signatures", () => {
        const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519");
        const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
        const publicDer = publicKey.export({ format: "der", type: "spki" });
        const message = Buffer.from("https://i.fullstacked.cloud/?exp=1791350554");

        const nodeSig = nodeCrypto.sign(null, message, privateKey);
        const pub = crypto.createPublicKey({ key: publicDer, format: "der", type: "spki" });
        assert.equal(crypto.verify(null, message, pub, nodeSig), true);

        const ourSig = crypto.sign(null, message, privatePem);
        assert.deepEqual(ourSig, nodeSig);
        assert.equal(nodeCrypto.verify(null, message, publicKey, ourSig), true);
        assert.equal(crypto.createPublicKey(privatePem).export({ format: "pem" }), publicKey.export({ format: "pem", type: "spki" }));
    });

    test("rejects tampered messages, signatures and non-canonical S", () => {
        const [seed, , msg, sig] = RFC8032[1];
        const publicKey = crypto.createPublicKey(privateFromSeed(seed));
        assert.equal(crypto.verify(null, hex("73"), publicKey, hex(sig)), false);
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
        assert.equal(crypto.verify(null, hex(msg), publicKey, hex(sig).subarray(0, 63)), false);
    });

    test("verify reports through a callback", async () => {
        const [seed, , msg, sig] = RFC8032[2];
        const publicKey = crypto.createPublicKey(privateFromSeed(seed));
        const result = await new Promise((resolve, reject) =>
            crypto.verify(null, hex(msg), publicKey, hex(sig), (err, ok) =>
                err ? reject(err) : resolve(ok)
            )
        );
        assert.equal(result, true);
    });
});
