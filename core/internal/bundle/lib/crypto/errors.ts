// The Node errors lib/crypto throws itself: argument validation and the
// state errors Node raises before OpenSSL is involved. Class and code are
// Node's; the messages are Node's or shortened from them.

import {
    invalidArgType,
    invalidArgValue,
    nodeError
} from "../util/internal.ts";
import { validateInteger } from "../buffer/errors.ts";

export {
    invalidArgType,
    invalidArgValue,
    validateFunction,
    validateObject,
    validateString
} from "../util/internal.ts";
export {
    ERR_OUT_OF_RANGE,
    validateInteger,
    validateNumber
} from "../buffer/errors.ts";

// The errors thrown by code, with Node's class. The message is Node's, or
// its start when the call adds a detail (a name, a length).
const ERRORS: Record<string, [ErrorConstructor, string]> = {
    ERR_CRYPTO_INVALID_STATE: [Error, "Invalid state"],
    ERR_CRYPTO_INVALID_DIGEST: [TypeError, "Invalid digest"],
    ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE: [TypeError, "Invalid key object type"],
    ERR_CRYPTO_INVALID_AUTH_TAG: [
        TypeError,
        "Invalid authentication tag length: "
    ],
    ERR_CRYPTO_INVALID_CURVE: [TypeError, "Invalid EC curve name"],
    ERR_CRYPTO_INVALID_IV: [TypeError, "Invalid initialization vector"],
    ERR_CRYPTO_INVALID_KEYLEN: [RangeError, "Invalid key length"],
    ERR_CRYPTO_INVALID_KEYPAIR: [RangeError, "Invalid key pair"],
    ERR_CRYPTO_UNKNOWN_CIPHER: [Error, "Unknown cipher"],
    ERR_CRYPTO_UNKNOWN_DH_GROUP: [Error, "Unknown DH group"],
    ERR_CRYPTO_HASH_FINALIZED: [Error, "Digest already called"],
    ERR_CRYPTO_SIGN_KEY_REQUIRED: [Error, "No key provided to sign"],
    ERR_CRYPTO_INCOMPATIBLE_KEY: [
        Error,
        "Incompatible key types for Diffie-Hellman: "
    ],
    ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS: [Error, "The selected key encoding "],
    ERR_CRYPTO_ECDH_INVALID_FORMAT: [TypeError, "Invalid ECDH format: "],
    ERR_CRYPTO_OPERATION_FAILED: [Error, "Failed to get ECDH "],
    ERR_CRYPTO_INVALID_SCRYPT_PARAMS: [RangeError, "Invalid scrypt params"],
    ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH: [
        RangeError,
        "Input buffers must have the same byte length"
    ],
    ERR_INCOMPATIBLE_OPTION_PAIR: [TypeError, "Incompatible options: "],
    ERR_INTERNAL_ASSERTION: [Error, "Cannot change encoding"],
    ERR_FEATURE_UNAVAILABLE_ON_PLATFORM: [
        Error,
        "Not supported by this runtime: "
    ],
    ERR_OSSL_UNSUPPORTED: [
        Error,
        "error:1E08010C:DECODER routines::unsupported"
    ],
    ERR_OSSL_EVP_UNSUPPORTED: [
        Error,
        "error:0308010C:digital envelope routines::unsupported"
    ],
    ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH: [
        Error,
        "error:030000B2:digital envelope routines::not XOF or invalid length"
    ],
    ERR_OSSL_DH_BAD_GENERATOR: [
        Error,
        "error:02800065:Diffie-Hellman routines::bad generator"
    ]
};

// the Node error of code, its message followed by detail
export function fail(code: string, detail: string | number = "") {
    const [Class, message] = ERRORS[code];
    return nodeError(new Class(message + detail), code);
}

export const BYTES =
    "an instance of ArrayBuffer, Buffer, TypedArray, or DataView";
export const STRING_OR_BYTES = "of type string or " + BYTES;

export const invalidState = (operation?: string) =>
    fail(
        "ERR_CRYPTO_INVALID_STATE",
        operation ? " for operation " + operation : ""
    );

export const invalidKeyObjectType = (type: string, expected: string) =>
    fail(
        "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
        ` ${type}, expected ${expected}.`
    );

export const validateInt32 = (value: unknown, name: string, min = -(2 ** 31)) =>
    validateInteger(value, name, min, 2 ** 31 - 1);

export const validateUint32 = (value: unknown, name: string) =>
    validateInteger(value, name, 0, 2 ** 32 - 1);

// Node's getUIntOption: an optional uint32 of an options object
export function uintOption(options: any, name: string): number | undefined {
    const value = options?.[name];
    if (value !== undefined && value >>> 0 !== value) {
        throw invalidArgValue("options." + name, value, "is invalid");
    }
    return value;
}

export function validateCallback(callback: unknown) {
    if (typeof callback !== "function") {
        throw invalidArgType("callback", "of type function", callback);
    }
}
