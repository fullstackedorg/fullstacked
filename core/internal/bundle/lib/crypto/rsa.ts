// publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt
// (lib/internal/crypto/cipher.js rsaFunctionFor): one core call each.

import { RsaCrypt } from "../@types/crypto.ts";
import { call } from "./core.ts";
import { hashName } from "./names.ts";
import { CONSUME_PRIVATE, CONSUME_PUBLIC, prepareKey } from "./keys.ts";
import { toBuffer, toBytes } from "./util.ts";
import { validateString } from "./errors.ts";

const OAEP = 4;
const PKCS1 = 1;

const rsa =
    (operation: string, defaultPadding: number, ctx: number) =>
    (options: any, buffer: any) => {
        const key = prepareKey(options, ctx);
        const { padding, oaepHash, oaepLabel, encoding } = options ?? {};
        if (oaepHash !== undefined) validateString(oaepHash, "key.oaepHash");
        return toBuffer(
            call(
                RsaCrypt,
                operation,
                key.der,
                toBytes(buffer, "buffer", encoding),
                padding || defaultPadding,
                oaepHash === undefined ? undefined : hashName(oaepHash),
                oaepLabel === undefined
                    ? undefined
                    : toBytes(oaepLabel, "key.oaepLabel", encoding)
            )
        );
    };

export const publicEncrypt = rsa("publicEncrypt", OAEP, CONSUME_PUBLIC);
export const privateDecrypt = rsa("privateDecrypt", OAEP, CONSUME_PRIVATE);
export const privateEncrypt = rsa("privateEncrypt", PKCS1, CONSUME_PRIVATE);
export const publicDecrypt = rsa("publicDecrypt", PKCS1, CONSUME_PUBLIC);
