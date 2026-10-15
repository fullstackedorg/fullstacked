// nodejs source: https://nodejs.org/docs/latest/api/crypto.html
//
// Node's crypto over the core's Crypto module (core/internal/crypto) and
// the TypeScript primitives (./primitives), improvements/shim/plan.md Stage 4: hashes,
// HMAC, AES-CTR and ChaCha20 in TS, the rest one core call per operation.
// Nothing calls the core at import time.

import allConstants from "../constants/index.ts";
import { Hash, Hmac, createHash, createHmac, hash } from "./hash.ts";
import {
    Cipheriv,
    Decipheriv,
    createCipheriv,
    createDecipheriv
} from "./cipher.ts";
import {
    KeyObject,
    createPrivateKey,
    createPublicKey,
    createSecretKey,
    generateKey,
    generateKeyPair,
    generateKeyPairSync,
    generateKeySync
} from "./keys.ts";
import {
    Sign,
    Verify,
    createSign,
    createVerify,
    sign,
    verify
} from "./sign.ts";
import {
    DiffieHellman,
    DiffieHellmanGroup,
    ECDH,
    createDiffieHellman,
    createDiffieHellmanGroup,
    createECDH,
    diffieHellman
} from "./dh.ts";
import {
    privateDecrypt,
    privateEncrypt,
    publicDecrypt,
    publicEncrypt
} from "./rsa.ts";
import {
    hkdf,
    hkdfSync,
    pbkdf2,
    pbkdf2Sync,
    scrypt,
    scryptSync
} from "./kdf.ts";
import {
    getRandomValues,
    randomBytes,
    randomFill,
    randomFillSync,
    randomInt,
    randomUUID,
    timingSafeEqual
} from "./random.ts";
import { getCiphers, getCurves, getHashes } from "./names.ts";
import { fail } from "./errors.ts";

// the crypto part of the constants table, from OPENSSL_VERSION_NUMBER on
const keys = Object.keys(allConstants);
export const constants: Record<string, number | string> = {};
for (const key of keys.slice(keys.indexOf("OPENSSL_VERSION_NUMBER"))) {
    constants[key] = (allConstants as Record<string, number | string>)[key];
}
constants.defaultCipherList = constants.defaultCoreCipherList;

export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;

export const getDiffieHellman = createDiffieHellmanGroup;

const unavailable = (what: string) => () => {
    throw fail("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", what);
};

export const getFips = () => 0;
export const setFips = (value: unknown) => value && unavailable("FIPS")();

// no X.509 parser and no SPKAC in the core: present so that imports
// resolve, throwing when used
export const X509Certificate = unavailable("X509Certificate");
export const Certificate = unavailable("Certificate");

export {
    Cipheriv,
    Decipheriv,
    DiffieHellman,
    DiffieHellmanGroup,
    ECDH,
    Hash,
    Hmac,
    KeyObject,
    Sign,
    Verify,
    createCipheriv,
    createDecipheriv,
    createDiffieHellman,
    createDiffieHellmanGroup,
    createECDH,
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    createSecretKey,
    createSign,
    createVerify,
    diffieHellman,
    generateKey,
    generateKeyPair,
    generateKeyPairSync,
    generateKeySync,
    getCiphers,
    getCurves,
    getHashes,
    getRandomValues,
    hash,
    hkdf,
    hkdfSync,
    pbkdf2,
    pbkdf2Sync,
    privateDecrypt,
    privateEncrypt,
    publicDecrypt,
    publicEncrypt,
    randomBytes,
    randomFill,
    randomFillSync,
    randomInt,
    randomUUID,
    scrypt,
    scryptSync,
    sign,
    timingSafeEqual,
    verify
};

export default {
    Certificate,
    Cipheriv,
    Decipheriv,
    DiffieHellman,
    DiffieHellmanGroup,
    ECDH,
    Hash,
    Hmac,
    KeyObject,
    Sign,
    Verify,
    X509Certificate,
    constants,
    createCipheriv,
    createDecipheriv,
    createDiffieHellman,
    createDiffieHellmanGroup,
    createECDH,
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    createSecretKey,
    createSign,
    createVerify,
    diffieHellman,
    generateKey,
    generateKeyPair,
    generateKeyPairSync,
    generateKeySync,
    getCiphers,
    getCurves,
    getDiffieHellman,
    getFips,
    getHashes,
    getRandomValues,
    hash,
    hkdf,
    hkdfSync,
    pbkdf2,
    pbkdf2Sync,
    privateDecrypt,
    privateEncrypt,
    publicDecrypt,
    publicEncrypt,
    randomBytes,
    randomFill,
    randomFillSync,
    randomInt,
    randomUUID,
    scrypt,
    scryptSync,
    setFips,
    sign,
    subtle,
    timingSafeEqual,
    verify,
    webcrypto
};
