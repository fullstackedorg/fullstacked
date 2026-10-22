// Algorithm names: Node takes OpenSSL's names and aliases in any case, the
// core and the TS primitives take one canonical lowercase name. The lists
// of getHashes/getCiphers/getCurves are what this runtime runs, under the
// names Node lists them.

// digest sizes of every hash, the default ones for the SHAKEs
export const HASH_SIZES: Record<string, number> = {
    md5: 16,
    sha1: 20,
    sha224: 28,
    sha256: 32,
    sha384: 48,
    sha512: 64,
    "sha512-224": 28,
    "sha512-256": 32,
    "sha3-224": 28,
    "sha3-256": 32,
    "sha3-384": 48,
    "sha3-512": 64,
    shake128: 16,
    shake256: 32,
    ripemd160: 20,
    blake2b512: 64,
    blake2s256: 32
};

const HASH_ALIASES: Record<string, string> = {
    ripemd: "ripemd160",
    rmd160: "ripemd160",
    ripemd160withrsa: "ripemd160",
    "ssl3-md5": "md5",
    "ssl3-sha1": "sha1",
    "sha1-2": "sha1"
};

// RSA-SHA256, sha256WithRSAEncryption, SHA-256, SHA2-256, RSA-SHA512/256,
// id-rsassa-pkcs1-v1_5-with-sha3-256 ... -> sha256, sha512-256, sha3-256
export function hashName(name: string) {
    let n = name.toLowerCase();
    if (n.startsWith("rsa-")) n = n.slice(4);
    n = n
        .replace(/withrsaencryption$/, "")
        .replace(/^id-rsassa-pkcs1-v1_5-with-/, "")
        .replace("/", "-")
        .replace(/^sha2?-(1|224|256|384|512)$/, "sha$1");
    return HASH_ALIASES[n] ?? n;
}

// Node's list, less the hashes the runtime does not have (md5-sha1, sm3)
export const getHashes = () =>
    (
        "RSA-MD5 RSA-RIPEMD160 RSA-SHA1 RSA-SHA1-2 RSA-SHA224 RSA-SHA256 " +
        "RSA-SHA3-224 RSA-SHA3-256 RSA-SHA3-384 RSA-SHA3-512 RSA-SHA384 " +
        "RSA-SHA512 RSA-SHA512/224 RSA-SHA512/256 blake2b512 blake2s256 " +
        "id-rsassa-pkcs1-v1_5-with-sha3-224 id-rsassa-pkcs1-v1_5-with-sha3-256 " +
        "id-rsassa-pkcs1-v1_5-with-sha3-384 id-rsassa-pkcs1-v1_5-with-sha3-512 " +
        "md5 md5WithRSAEncryption ripemd ripemd160 ripemd160WithRSA rmd160 " +
        "sha1 sha1WithRSAEncryption sha224 sha224WithRSAEncryption sha256 " +
        "sha256WithRSAEncryption sha3-224 sha3-256 sha3-384 sha3-512 sha384 " +
        "sha384WithRSAEncryption sha512 sha512-224 sha512-224WithRSAEncryption " +
        "sha512-256 sha512-256WithRSAEncryption sha512WithRSAEncryption " +
        "shake128 shake256 ssl3-md5 ssl3-sha1"
    ).split(" ");

export type CipherInfo = {
    name: string;
    keyLength: number;
    // 0 for ECB; GCM takes 1 to 128 bytes, 12 being the default
    ivLength: number;
    // cbc, ecb, ctr, cfb, cfb8, ofb, gcm, chacha20, poly1305 or des (the
    // single DES modes, which Node 24 does not load)
    mode: string;
};

const AES_MODES = ["cbc", "ecb", "ctr", "cfb", "cfb8", "ofb", "gcm"];

const CIPHERS: Record<string, [number, number, string]> = {
    chacha20: [32, 16, "chacha20"],
    "chacha20-poly1305": [32, 12, "poly1305"],
    "des-ede3-cbc": [24, 8, "cbc"],
    "des-ede3": [24, 0, "ecb"],
    "des-ede-cbc": [16, 8, "cbc"],
    "des-ede": [16, 0, "ecb"],
    "des-cbc": [8, 8, "des"],
    "des-ecb": [8, 0, "des"]
};

const CIPHER_ALIASES: Record<string, string> = {
    des3: "des-ede3-cbc",
    "des-ede3-ecb": "des-ede3",
    "des-ede-ecb": "des-ede",
    des: "des-cbc"
};

export function cipherInfo(name: string): CipherInfo | undefined {
    let n = name.toLowerCase();
    n = (CIPHER_ALIASES[n] ?? n)
        .replace(/^aes(128|192|256)$/, "aes-$1-cbc")
        .replace(/^id-aes(128|192|256)-gcm$/, "aes-$1-gcm");
    const aes = /^aes-(128|192|256)-([a-z0-9]+)$/.exec(n);
    if (aes && AES_MODES.includes(aes[2])) {
        const mode = aes[2];
        return {
            name: n,
            keyLength: +aes[1] / 8,
            ivLength: mode === "ecb" ? 0 : mode === "gcm" ? 12 : 16,
            mode
        };
    }
    const other = CIPHERS[n];
    if (other) {
        return {
            name: n,
            keyLength: other[0],
            ivLength: other[1],
            mode: other[2]
        };
    }
}

export function getCiphers() {
    const list = [
        "chacha20",
        "chacha20-poly1305",
        "des-ede",
        "des-ede-cbc",
        "des-ede-ecb",
        "des-ede3",
        "des-ede3-cbc",
        "des-ede3-ecb",
        "des3"
    ];
    for (const bits of [128, 192, 256]) {
        list.push(`aes${bits}`, `id-aes${bits}-gcm`);
        for (const mode of AES_MODES) list.push(`aes-${bits}-${mode}`);
    }
    return list.sort();
}

export const getCurves = () => [
    "prime256v1",
    "secp224r1",
    "secp256k1",
    "secp384r1",
    "secp521r1"
];

// generateKeyPair's namedCurve also takes the NIST names
export function curveName(name: string) {
    return (
        (
            {
                "P-224": "secp224r1",
                "P-256": "prime256v1",
                "P-384": "secp384r1",
                "P-521": "secp521r1",
                secp256r1: "prime256v1"
            } as Record<string, string>
        )[name] ?? name
    );
}
