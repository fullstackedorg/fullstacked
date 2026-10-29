// HMAC (RFC 2104, FIPS 198-1) over any TsHash.
//
// The padded key blocks are hashed when the instance is created, so
// update() goes straight to the inner hash and digest() costs the inner
// finalization plus one outer block, as in OpenSSL's HMAC_Final.

import type { TsHash } from "./index.ts";

export class Hmac implements TsHash {
    readonly blockSize: number;
    readonly outputLength: number;
    private readonly inner: TsHash;
    private readonly outer: TsHash;

    // inner and outer are fresh instances of the same hash and key at most
    // a block long (createTsHmac hashes longer ones); for copy(), the copies
    // of another Hmac's and no key
    constructor(inner: TsHash, outer: TsHash, key?: Uint8Array) {
        this.inner = inner;
        this.outer = outer;
        this.blockSize = inner.blockSize;
        this.outputLength = inner.outputLength;
        if (key === undefined) return;
        const blockSize = inner.blockSize;
        const pad = new Uint8Array(blockSize);
        for (let i = 0; i < key.length; i++) pad[i] = key[i] ^ 0x36;
        for (let i = key.length; i < blockSize; i++) pad[i] = 0x36;
        inner.update(pad);
        // 0x36 ^ 0x5c turns the inner pad into the outer one
        for (let i = 0; i < blockSize; i++) pad[i] ^= 0x6a;
        outer.update(pad);
    }

    update(data: Uint8Array) {
        this.inner.update(data);
    }

    digest() {
        this.outer.update(this.inner.digest());
        return this.outer.digest();
    }

    copy(): TsHash {
        return new Hmac(this.inner.copy(), this.outer.copy());
    }
}
