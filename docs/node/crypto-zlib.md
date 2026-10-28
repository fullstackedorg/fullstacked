# Crypto and zlib

Back to the [module table](index.md).

## crypto

`node:crypto` is split between the page and the core, depending on what is cheaper per call:

- **TypeScript in the page, no core call:** MD5, SHA-1, the SHA-2 family, HMAC over them, AES-CTR and ChaCha20 (protocols like SSH make a cipher or HMAC per packet, so these must not cross the bridge), plus random bytes from `crypto.getRandomValues`.
- **In the core, one call per operation:** SHA-3, SHAKE, BLAKE2, RIPEMD-160, the other ciphers (AES-GCM, CBC, ECB, CFB, OFB, ChaCha20-Poly1305, 3DES, DES), key parsing, export and generation, sign and verify, RSA encryption, Diffie-Hellman, ECDH, PBKDF2, scrypt and HKDF.

Nothing calls the core at import time.

### Supported

| Area          | API                                                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hashes        | `createHash`, `hash` (one-shot), `Hash.copy()`, `getHashes()`: md5, sha1, sha224, sha256, sha384, sha512, sha512-224, sha512-256, sha3-224/256/384/512, shake128, shake256, ripemd160, blake2b512, blake2s256, and the `RSA-*`/`*WithRSAEncryption` aliases                                          |
| HMAC          | `createHmac` with any of the hashes above                                                                                                                                                                                                                                                            |
| Ciphers       | `createCipheriv`, `createDecipheriv`, `getCiphers()`: aes-128/192/256 in cbc, ecb, ctr, cfb, cfb8, ofb and gcm; chacha20, chacha20-poly1305; des-ede3(-cbc), des-ede(-cbc), des(-cbc/-ecb). Also `setAutoPadding`, `setAAD`, `getAuthTag` and `setAuthTag`.                                          |
| Keys          | `createPublicKey`, `createPrivateKey`, `createSecretKey`, `KeyObject` (`export` as PEM, DER or JWK), `generateKeyPair(Sync)` for rsa, rsa-pss, ec, ed25519, ed448, x25519 and x448, `generateKey(Sync)` for hmac and aes                                                                             |
| Signatures    | `createSign`, `createVerify`, `sign`, `verify`: RSA PKCS#1 v1.5, RSA-PSS, ECDSA (DER or `ieee-p1363`), Ed25519, Ed448                                                                                                                                                                                |
| RSA           | `publicEncrypt`, `privateDecrypt`, `privateEncrypt`, `publicDecrypt`                                                                                                                                                                                                                                 |
| Key agreement | `createDiffieHellman(prime \| length, generator)`, `createDiffieHellmanGroup`/`getDiffieHellman` (modp1, modp2, modp5, modp14 to modp18), `createECDH` on `getCurves()` (prime256v1, secp224r1, secp256k1, secp384r1, secp521r1), `diffieHellman({ privateKey, publicKey })` for X25519, X448 and EC |
| KDFs          | `pbkdf2(Sync)`, `scrypt(Sync)`, `hkdf(Sync)`                                                                                                                                                                                                                                                         |
| Random        | `randomBytes`, `randomFill(Sync)`, `randomInt`, `randomUUID`, `getRandomValues`                                                                                                                                                                                                                      |
| Misc          | `timingSafeEqual`, `constants`, `getFips()` (always 0), `setFips`                                                                                                                                                                                                                                    |
| Web Crypto    | `webcrypto` and `subtle` are the webview's `crypto` and `crypto.subtle`                                                                                                                                                                                                                              |

`ssh2` runs every algorithm OpenSSH 10 accepts on this module in the webview, including `curve25519-sha256`, `chacha20-poly1305@openssh.com`, `diffie-hellman-group-exchange-*` and every modp group (36 of 36 combinations that Node completes).

### Not provided

`X509Certificate` and `Certificate` throw. DSA and DH key generation (`generateKeyPair("dsa" | "dh")`) throws `ERR_OSSL_UNSUPPORTED`. There are no engine or secure heap APIs.

Error objects carry Node's `code` (`ERR_CRYPTO_INVALID_KEYLEN`, `ERR_OSSL_BAD_DECRYPT`, …) where the conformance suite checks them, but not OpenSSL's `library`, `reason` or `opensslErrorStack`.

## zlib

`node:zlib` from Node 24 over Go's `compress/flate` (via klauspost) and `andybalholm/brotli`:

- **Sync one-shots** (`deflateSync`, `gunzipSync`, `brotliCompressSync`, …) are one sync core call.
- **Callback and promise forms** (`deflate`, `gzip`, …) are one async call, so the compression runs off the page's thread.
- **Streams** (`createGzip()`, `createInflate()`, `createBrotliDecompress()`, …) are `stream.Transform`s, with one async call per chunk.
- **`crc32(data, initial?)`** runs in TypeScript.

The classes (`Deflate`, `Inflate`, `Gzip`, `Gunzip`, `DeflateRaw`, `InflateRaw`, `Unzip`, `BrotliCompress`, `BrotliDecompress`) are function constructors as in Node. `constants`, `codes`, `info: true` and `maxOutputLength` are supported.

### Differences

- **No zstd** (`zstdCompress`, `createZstdCompress`, …). It will be added when a consumer needs it.
- **Compressed bytes differ from Node's.** Go's flate and brotli aren't zlib and libbrotli. Every stream is valid and Node decodes it, but it isn't byte-identical.
- `Z_FILTERED`, `Z_RLE`, `Z_FIXED` and `memLevel` are accepted and compress like the defaults. A `windowBits` below 15 compresses with Huffman coding only. `Z_FULL_FLUSH` flushes like `Z_SYNC_FLUSH` (the match window is kept). The brotli mode and size hint are ignored.
- The message of an error in deflate data is generic, but its `code` and `errno` are zlib's.
- Streams emit a write's output as one chunk, with no `chunkSize` slicing.
