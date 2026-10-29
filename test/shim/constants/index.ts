import { suite } from "node:test";
import nodeConstants from "node:constants";
import nodeCrypto from "node:crypto";
import libConstants, * as libNamed from "../../../core/internal/bundle/lib/constants/index.ts";
import { check } from "../common.ts";
import assert from "node:assert";

// The table is Node's require("constants") of macOS, generated once
// (improvements/shim/plan.md 5.4). The errno, signal, fs and dlopen tables
// are the host OS's in Node, so they are compared in full on darwin only;
// elsewhere the names packages rely on must be there. defaultCipherList is
// left out: Node adds it once its TLS is loaded.
const nodeTable = Object.fromEntries(
    Object.entries(nodeConstants).filter(([k]) => k !== "defaultCipherList")
);

const PORTABLE = [
    "F_OK",
    "R_OK",
    "W_OK",
    "X_OK",
    "O_RDONLY",
    "O_WRONLY",
    "O_RDWR",
    "O_CREAT",
    "O_EXCL",
    "O_TRUNC",
    "O_APPEND",
    "S_IFMT",
    "S_IFREG",
    "S_IFDIR",
    "S_IFLNK",
    "COPYFILE_EXCL",
    "SIGINT",
    "SIGTERM",
    "SIGKILL",
    "ENOENT",
    "EACCES",
    "EEXIST",
    "EPIPE",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT"
];

const CRYPTO = [
    "RSA_PKCS1_PADDING",
    "RSA_NO_PADDING",
    "RSA_PKCS1_OAEP_PADDING",
    "RSA_PKCS1_PSS_PADDING",
    "RSA_PSS_SALTLEN_DIGEST",
    "RSA_PSS_SALTLEN_MAX_SIGN",
    "RSA_PSS_SALTLEN_AUTO",
    "POINT_CONVERSION_COMPRESSED",
    "POINT_CONVERSION_UNCOMPRESSED",
    "POINT_CONVERSION_HYBRID",
    "TLS1_2_VERSION",
    "TLS1_3_VERSION"
];

suite("shim constants", () => {
    check("constants", "same names as node:constants on darwin", () => {
        if (process.platform !== "darwin") return;
        assert.deepStrictEqual(
            Object.keys(libConstants).sort(),
            Object.keys(nodeTable).sort()
        );
    });
    check("constants", "same values on darwin", () => {
        if (process.platform !== "darwin") return;
        assert.deepStrictEqual({ ...libConstants }, nodeTable);
    });
    check("constants", "the portable names", () => {
        for (const key of PORTABLE) {
            assert.equal(typeof (libConstants as any)[key], "number", key);
            assert.ok(key in nodeTable, key);
        }
    });
    // what Node's crypto.constants has depends on its OpenSSL build (24.20
    // on Linux adds RSA_SSLV23_PADDING): the names both have agree, and the
    // ones packages use are there
    check("constants", "the crypto table", () => {
        for (const [key, value] of Object.entries(nodeCrypto.constants)) {
            if (
                key in libConstants &&
                key !== "OPENSSL_VERSION_NUMBER" &&
                key !== "defaultCoreCipherList"
            ) {
                assert.equal((libConstants as any)[key], value, key);
            }
        }
        for (const key of CRYPTO) {
            assert.equal(
                (libConstants as any)[key],
                (nodeCrypto.constants as any)[key],
                key
            );
        }
    });
    check("constants", "named exports match the default", () => {
        for (const [key, value] of Object.entries(libConstants)) {
            assert.equal(
                (libNamed as Record<string, unknown>)[key],
                value,
                key
            );
        }
    });
});
