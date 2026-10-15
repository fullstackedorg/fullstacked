import { suite } from "node:test";
import * as nodeBuffer from "node:buffer";
import "../../../core/internal/bundle/lib/buffer/index.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import { sameFor } from "../common.ts";

type BufferModule = typeof nodeBuffer;
const shim = libBuffer as unknown as BufferModule;
const same = sameFor<BufferModule>("buffer", shim, nodeBuffer);

const STRINGS = [
    "",
    "hello",
    "héllo wörld",
    "€uro 中文 😀",
    "\u0000\u007f\u0080ÿ",
    "lone \ud800 surrogate \udc00",
    "a".repeat(300)
];
const ENCODINGS = [
    "utf8",
    "utf-8",
    "utf16le",
    "ucs2",
    "latin1",
    "binary",
    "ascii",
    "hex",
    "base64",
    "base64url"
] as const;
const BYTES = Array.from({ length: 256 }, (_, i) => i);
// invalid utf8: truncated sequences, overlong, surrogates, out of range
const INVALID_UTF8 = [
    0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x90, 0x28, 0xbc, 0xc0,
    0xaf, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0xe2, 0x82
];

suite("shim buffer - conversions", () => {
    for (const encoding of ENCODINGS) {
        same(`from(string, ${encoding})`, ({ Buffer }) =>
            STRINGS.map((s) => Buffer.from(s, encoding))
        );
        same(`toString(${encoding}) of every byte value`, ({ Buffer }) =>
            Buffer.from(BYTES).toString(encoding)
        );
        same(`byteLength(string, ${encoding})`, ({ Buffer }) =>
            STRINGS.map((s) => Buffer.byteLength(s, encoding))
        );
    }
    same("toString(utf8) of invalid sequences", ({ Buffer }) =>
        Buffer.from(INVALID_UTF8).toString("utf8")
    );
    same("toString(encoding, start, end)", ({ Buffer }) => {
        const b = Buffer.from("€uro 中文 😀");
        return [
            b.toString("utf8", 1, 7),
            b.toString("hex", 2),
            b.toString("base64", 0, 5),
            b.toString("utf8", -5, 100),
            b.toString("utf8", 5, 2)
        ];
    });
    same("from(hex) with invalid and odd input", ({ Buffer }) => [
        Buffer.from("abz1", "hex"),
        Buffer.from("abc", "hex"),
        Buffer.from("zz", "hex"),
        Buffer.from("ABcd", "hex")
    ]);
    same(
        "from(base64) with whitespace, url chars and no padding",
        ({ Buffer }) => [
            Buffer.from("aGVs bG8=\n", "base64"),
            Buffer.from("aGVsbG8", "base64"),
            Buffer.from("-_-_", "base64"),
            Buffer.from("aGVsbG8===", "base64")
        ]
    );
    same("from(base64url) with standard chars", ({ Buffer }) =>
        Buffer.from("+/+/", "base64url")
    );
    same("from(array, arrayBuffer, buffer, object)", ({ Buffer }) => {
        const ab = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        return [
            Buffer.from([1, 256, -1, 3.7, "4" as any]),
            Buffer.from(ab, 1, 3),
            Buffer.from(Buffer.from("abc")),
            Buffer.from({ length: 2, 0: 9, 1: 8 } as any),
            Buffer.from(new Uint16Array([1, 0x102]))
        ];
    });
    same("from(arrayBuffer) shares memory", ({ Buffer }) => {
        const ab = new ArrayBuffer(4);
        const b = Buffer.from(ab);
        new Uint8Array(ab)[0] = 7;
        return b[0];
    });
    same("from() rejects numbers and null", ({ Buffer }) => [
        (() => {
            try {
                return Buffer.from(5 as any);
            } catch (e) {
                return (e as any).code ?? (e as Error).name;
            }
        })(),
        (() => {
            try {
                return Buffer.from(null);
            } catch (e) {
                return (e as any).code ?? (e as Error).name;
            }
        })()
    ]);
    same("toJSON", ({ Buffer }) => Buffer.from("hi").toJSON());
    same("isEncoding", ({ Buffer }) =>
        [...ENCODINGS, "UTF8", "Hex", "foo", "", "latin-1"].map((e) =>
            Buffer.isEncoding(e)
        )
    );
});

suite("shim buffer - allocation and copies", () => {
    same("alloc with fills", ({ Buffer }) => [
        Buffer.alloc(5),
        Buffer.alloc(5, "ab"),
        Buffer.alloc(5, 0x101),
        Buffer.alloc(6, "aGk=", "base64"),
        Buffer.alloc(3, Buffer.from([1, 2])),
        Buffer.alloc(4, "")
    ]);
    same("alloc rejects invalid sizes", ({ Buffer }) => Buffer.alloc(-1));
    same("allocUnsafe length", ({ Buffer }) => Buffer.allocUnsafe(10).length);
    same("concat", ({ Buffer }) => {
        const list = [
            Buffer.from("ab"),
            Buffer.from("cde"),
            new Uint8Array([1])
        ];
        return [
            Buffer.concat(list),
            Buffer.concat(list, 3),
            Buffer.concat(list, 10),
            Buffer.concat([])
        ];
    });
    same("compare, equals", ({ Buffer }) => {
        const a = Buffer.from("abc");
        const b = Buffer.from("abd");
        return [
            Buffer.compare(a, b),
            Buffer.compare(b, a),
            Buffer.compare(a, Buffer.from("abc")),
            a.compare(b, 0, 2, 0, 2),
            a.equals(Buffer.from("abc"))
        ];
    });
    same("equals and compare with a Uint8Array", ({ Buffer }) => {
        const a = Buffer.from("abc");
        const u = new Uint8Array([97, 98, 99]);
        return [a.equals(u), Buffer.compare(a, u)];
    });
    same("indexOf, lastIndexOf, includes", ({ Buffer }) => {
        const b = Buffer.from("this is a buffer, a buffer");
        return [
            b.indexOf("buffer"),
            b.indexOf("buffer", 11),
            b.indexOf("buffer", -6),
            b.indexOf(Buffer.from("a b")),
            b.indexOf(0x61),
            b.indexOf(0x161),
            b.indexOf("YSBi", 0, "base64"),
            b.lastIndexOf("buffer"),
            b.lastIndexOf("a", -10),
            b.includes("is a"),
            b.includes("nope")
        ];
    });
    same("indexOf of an empty needle", ({ Buffer }) => {
        const b = Buffer.from("abc");
        return [b.indexOf(""), b.indexOf("", 1), b.indexOf("", 100)];
    });
    same("slice and subarray are views", ({ Buffer }) => {
        const b = Buffer.from("abcdef");
        const s = b.slice(1, 3);
        const t = b.subarray(-2);
        s[0] = 0x7a;
        return [b, s, t, b.slice(4, 2), b.slice(-100, 100)];
    });
    same("copy", ({ Buffer }) => {
        const src = Buffer.from("abcdef");
        const dst = Buffer.alloc(8, ".");
        const n = src.copy(dst, 2, 1, 4);
        const overlap = Buffer.from("abcdef");
        overlap.copy(overlap, 2, 0, 4);
        return [n, dst, overlap, src.copy(dst, 7)];
    });
    same("fill", ({ Buffer }) => [
        Buffer.alloc(6).fill("ab", 1, 5),
        Buffer.alloc(4).fill(0x1ff),
        Buffer.alloc(4).fill("Zg==", "base64"),
        Buffer.alloc(4).fill(Buffer.from([1, 2, 3]))
    ]);
    same("write(string, offset, length, encoding)", ({ Buffer }) => {
        const b = Buffer.alloc(10);
        return [
            b.write("héllo"),
            b.write("ab", 8),
            b.write("abcdef", 6, 2),
            b.write("6869", 0, "hex"),
            b.write("€", 9),
            b
        ];
    });
    same("swap16, swap32, swap64", ({ Buffer }) => [
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap16(),
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap32(),
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64()
    ]);
    same("swap16 rejects odd lengths", ({ Buffer }) =>
        Buffer.from([1, 2, 3]).swap16()
    );
    same("instanceof Uint8Array, isBuffer", ({ Buffer }) => [
        Buffer.from("a") instanceof Uint8Array,
        Buffer.isBuffer(Buffer.from("a")),
        Buffer.isBuffer(new Uint8Array(1))
    ]);
    same("INSPECT_MAX_BYTES", (m) => m.INSPECT_MAX_BYTES);
});

suite("shim buffer - numbers", () => {
    const bytes = [0x01, 0x80, 0xff, 0x7f, 0x00, 0x12, 0x34, 0x56, 0x78, 0x9a];
    const reads = [
        "readUInt8",
        "readInt8",
        "readUInt16LE",
        "readUInt16BE",
        "readInt16LE",
        "readInt16BE",
        "readUInt32LE",
        "readUInt32BE",
        "readInt32LE",
        "readInt32BE",
        "readFloatLE",
        "readFloatBE",
        "readBigUInt64LE",
        "readBigUInt64BE",
        "readBigInt64LE",
        "readBigInt64BE"
    ] as const;
    same("read* at every offset", ({ Buffer }) => {
        const b = Buffer.from(bytes);
        return reads.map((fn) =>
            [0, 1, 2].map((offset) => (b as any)[fn](offset))
        );
    });
    same("readDouble*", ({ Buffer }) => {
        const b = Buffer.from(bytes);
        return [b.readDoubleLE(0), b.readDoubleBE(1), b.readDoubleLE(2)];
    });
    same("read(U)Int(LE|BE) with byteLength 1-6", ({ Buffer }) => {
        const b = Buffer.from(bytes);
        return [1, 2, 3, 4, 5, 6].map((n) => [
            b.readUIntLE(1, n),
            b.readUIntBE(1, n),
            b.readIntLE(1, n),
            b.readIntBE(1, n)
        ]);
    });
    same("read out of range", ({ Buffer }) => Buffer.alloc(3).readUInt32LE(0));
    same("readUInt8 with a fractional offset", ({ Buffer }) =>
        Buffer.alloc(3).readUInt8(1.5)
    );
    same("write* round trips", ({ Buffer }) => {
        const b = Buffer.alloc(32);
        return [
            b.writeUInt8(255, 0),
            b.writeInt8(-128, 1),
            b.writeUInt16LE(0xbeef, 2),
            b.writeInt16BE(-2, 4),
            b.writeUInt32BE(0xdeadbeef, 6),
            b.writeInt32LE(-123456, 10),
            b.writeFloatBE(1.5, 14),
            b.writeDoubleLE(Math.PI, 18),
            b.writeBigInt64BE(-5n, 24),
            b
        ];
    });
    same("write(U)Int with byteLength 1-6", ({ Buffer }) =>
        [1, 2, 3, 4, 5, 6].map((n) => {
            const b = Buffer.alloc(14);
            b.writeUIntLE(2 ** (8 * n) - 3, 0, n);
            b.writeIntBE(-(2 ** (8 * n - 1)) + 1, 7, n);
            return b;
        })
    );
    same("write value out of range", ({ Buffer }) =>
        Buffer.alloc(2).writeUInt8(256, 0)
    );
    same("writeInt16LE value out of range", ({ Buffer }) =>
        Buffer.alloc(2).writeInt16LE(40000, 0)
    );
    same("write offset out of range", ({ Buffer }) =>
        Buffer.alloc(2).writeUInt16LE(1, 1)
    );
    same("lowercase aliases (readUint32LE, writeUint16BE)", ({ Buffer }) => {
        const b = Buffer.alloc(4);
        b.writeUint16BE(0x1234, 0);
        return [b.readUint32LE(0), typeof b.readBigUint64LE];
    });
});

suite("shim buffer - internal slices and writes", () => {
    // string_decoder and readline call these, lib/buffer/index.ts patches them
    const slices = [
        "asciiSlice",
        "latin1Slice",
        "utf8Slice",
        "base64Slice",
        "base64urlSlice",
        "hexSlice",
        "ucs2Slice"
    ];
    same("*Slice(start, end)", ({ Buffer }) => {
        const b = Buffer.from("héllo €");
        return slices.map((fn) => (b as any)[fn](1, 7));
    });
    const writes = [
        "asciiWrite",
        "latin1Write",
        "utf8Write",
        "base64Write",
        "hexWrite",
        "ucs2Write"
    ];
    same("*Write(string, offset, length)", ({ Buffer }) =>
        writes.map((fn) => {
            const b = Buffer.alloc(8);
            const input =
                fn === "hexWrite"
                    ? "abcd"
                    : fn === "base64Write"
                      ? "aGk="
                      : "hé";
            return [(b as any)[fn](input, 1, 6), b];
        })
    );
});
