import test, { suite } from "node:test";
import assert from "node:assert";
import nodeZlib from "node:zlib";
import libZlib from "../../../core/internal/bundle/lib/zlib/index.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import { sameFor, settle } from "../common.ts";

type ZlibModule = typeof nodeZlib;
type Env = { zlib: ZlibModule; Buffer: typeof Buffer };
const shim: Env = {
    zlib: libZlib as unknown as ZlibModule,
    Buffer: (libBuffer as any).Buffer
};
const node: Env = { zlib: nodeZlib, Buffer };
const same = sameFor<Env>("zlib", shim, node);

const TEXT =
    "The quick brown fox jumps over the lazy dog. ".repeat(500) + "€😀";
const RANDOM = Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) & 0xff);

// Compressed bytes are not compared: any valid stream is conformant, and
// Node's zlib (Chromium's) and Go's compress/flate both differ from pako.
// What Node decompresses back, and the stream header, are compared.
const INFLATE = {
    deflateSync: nodeZlib.inflateSync,
    deflateRawSync: nodeZlib.inflateRawSync,
    gzipSync: nodeZlib.gunzipSync
};
function decoded(fn: keyof typeof INFLATE, out: Uint8Array) {
    const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    return {
        roundTrip: INFLATE[fn](bytes).toString("latin1"),
        // gzip: up to XFL, the OS byte differs by implementation
        header: bytes
            .subarray(0, fn === "gzipSync" ? 9 : fn === "deflateSync" ? 2 : 0)
            .toString("hex")
    };
}

suite("shim zlib - one-shot", () => {
    for (const fn of ["deflateSync", "deflateRawSync", "gzipSync"] as const) {
        for (const level of [0, 1, 6, 9]) {
            same(`${fn} level ${level}`, ({ zlib, Buffer }) =>
                decoded(fn, zlib[fn](Buffer.from(TEXT), { level }))
            );
        }
        same(`${fn} random data`, ({ zlib, Buffer }) =>
            decoded(fn, zlib[fn](Buffer.from(RANDOM)))
        );
    }
    same("deflateSync windowBits, memLevel, strategy", ({ zlib, Buffer }) => [
        decoded(
            "deflateSync",
            zlib.deflateSync(Buffer.from(TEXT), { windowBits: 9 })
        ),
        decoded(
            "deflateSync",
            zlib.deflateSync(Buffer.from(TEXT), { memLevel: 1 })
        ),
        decoded(
            "deflateSync",
            zlib.deflateSync(Buffer.from(TEXT), {
                strategy: zlib.constants.Z_HUFFMAN_ONLY
            })
        ),
        decoded(
            "deflateSync",
            zlib.deflateSync(Buffer.from(TEXT), {
                strategy: zlib.constants.Z_RLE
            })
        )
    ]);
    same(
        "round trips: inflate, inflateRaw, gunzip, unzip",
        ({ zlib, Buffer }) => {
            const data = Buffer.from(TEXT);
            return [
                zlib.inflateSync(zlib.deflateSync(data)).toString(),
                zlib.inflateRawSync(zlib.deflateRawSync(data)).toString(),
                zlib.gunzipSync(zlib.gzipSync(data)).toString(),
                zlib.unzipSync(zlib.gzipSync(data)).toString(),
                zlib.unzipSync(zlib.deflateSync(data)).toString()
            ].map((s) => s === TEXT);
        }
    );
    same(
        "inflate of Node's output",
        ({ zlib, Buffer }) =>
            zlib
                .inflateSync(
                    Buffer.from(nodeZlib.deflateSync(TEXT, { level: 9 }))
                )
                .toString() === TEXT
    );
    same("gunzip of concatenated members", ({ zlib, Buffer }) =>
        zlib
            .gunzipSync(
                Buffer.concat([
                    zlib.gzipSync(Buffer.from("a")),
                    zlib.gzipSync(Buffer.from("b"))
                ])
            )
            .toString()
    );
    same("string input", ({ zlib }) =>
        decoded("deflateSync", zlib.deflateSync("text as a string"))
    );
    same("truncated input", ({ zlib, Buffer }) =>
        zlib.inflateSync(
            Buffer.from(nodeZlib.deflateSync(TEXT)).subarray(0, 50)
        )
    );
    same(
        "truncated input with finishFlush Z_SYNC_FLUSH",
        ({ zlib, Buffer }) =>
            zlib.inflateSync(
                Buffer.from(nodeZlib.deflateSync(TEXT)).subarray(0, 50),
                {
                    finishFlush: zlib.constants.Z_SYNC_FLUSH
                }
            ).length
    );
    same("corrupt header", ({ zlib, Buffer }) =>
        zlib.inflateSync(Buffer.from([1, 2, 3, 4]))
    );
    same("gunzip of non-gzip data", ({ zlib, Buffer }) =>
        zlib.gunzipSync(Buffer.from("plain"))
    );
    same("info option", ({ zlib, Buffer }) => {
        const r = zlib.deflateSync(Buffer.from("x"), { info: true }) as any;
        return [typeof r.buffer, typeof r.engine];
    });
    same("maxOutputLength", ({ zlib, Buffer }) =>
        zlib.inflateSync(zlib.deflateSync(Buffer.from(TEXT)), {
            maxOutputLength: 100
        })
    );
    same("dictionary", ({ zlib, Buffer }) => {
        const dictionary = Buffer.from("quick brown fox");
        const out = zlib.deflateSync(Buffer.from(TEXT), { dictionary });
        return [
            nodeZlib.inflateSync(Buffer.from(out), {
                dictionary: Buffer.from(dictionary)
            }).length,
            zlib.inflateSync(out, { dictionary }).length
        ];
    });
});

suite("shim zlib - async and streams", () => {
    same("callback forms", async ({ zlib, Buffer }) => {
        const deflated = await new Promise<Buffer>((resolve, reject) =>
            zlib.deflate(Buffer.from(TEXT), (e, r) =>
                e ? reject(e) : resolve(r)
            )
        );
        const inflated = await new Promise<Buffer>((resolve, reject) =>
            zlib.inflate(deflated, (e, r) => (e ? reject(e) : resolve(r)))
        );
        return [decoded("deflateSync", deflated), inflated.toString() === TEXT];
    });
    same(
        "callback error",
        async ({ zlib, Buffer }) =>
            new Promise((resolve) =>
                zlib.gunzip(Buffer.from("x"), (e) => resolve(e))
            )
    );
    same("createGzip stream output", async ({ zlib, Buffer }) => {
        const gzip = zlib.createGzip();
        const chunks: Uint8Array[] = [];
        gzip.on("data", (c: Uint8Array) => chunks.push(c));
        const done = new Promise((resolve) => gzip.on("end", resolve));
        gzip.write(Buffer.from(TEXT.slice(0, 1000)));
        gzip.end(Buffer.from(TEXT.slice(1000)));
        await done;
        return decoded("gzipSync", Buffer.concat(chunks));
    });
    // ssh2 compresses each packet with Z_SYNC_FLUSH and reads the output
    same("Z_SYNC_FLUSH as ssh2 uses it", async ({ zlib, Buffer }) => {
        const deflate = zlib.createDeflate();
        const inflate = zlib.createInflate();
        const out: string[] = [];
        const flushed: Uint8Array[] = [];
        deflate.on("data", (c: Uint8Array) => flushed.push(c));
        inflate.on("data", (c: Uint8Array) =>
            out.push(Buffer.from(c).toString())
        );
        for (const packet of ["first packet", "second packet"]) {
            flushed.length = 0;
            deflate.write(Buffer.from(packet));
            await new Promise<void>((resolve) =>
                deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve())
            );
            const compressed = Buffer.concat(flushed);
            inflate.write(compressed);
            await new Promise<void>((resolve) =>
                inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve())
            );
            out.push(`|${compressed.length > 0}`);
        }
        await settle();
        return out;
    });
    same("pipeline through gzip and gunzip", async ({ zlib, Buffer }) => {
        const gzip = zlib.createGzip();
        const gunzip = zlib.createGunzip();
        const out: Uint8Array[] = [];
        gunzip.on("data", (c: Uint8Array) => out.push(c));
        const done = new Promise((resolve) => gunzip.on("end", resolve));
        gzip.pipe(gunzip);
        gzip.end(Buffer.from(TEXT));
        await done;
        return Buffer.concat(out).toString() === TEXT;
    });
    same("promisified", async ({ zlib, Buffer }) => {
        const { promisify } = await import("node:util");
        return (
            ((await promisify(zlib.gzip)(Buffer.from("p"))) as Uint8Array)
                .length > 0
        );
    });
});

suite("shim zlib - brotli, crc32, constants", () => {
    same("brotliCompressSync and brotliDecompressSync", ({ zlib, Buffer }) => {
        const out = zlib.brotliCompressSync(Buffer.from(TEXT), {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
        });
        return [
            nodeZlib.brotliDecompressSync(Buffer.from(out)).toString() === TEXT,
            zlib.brotliDecompressSync(out).toString() === TEXT
        ];
    });
    same(
        "createBrotliCompress",
        ({ zlib }) => typeof zlib.createBrotliCompress
    );
    same("crc32", ({ zlib, Buffer }) => [
        zlib.crc32(Buffer.from(TEXT)),
        zlib.crc32("text"),
        zlib.crc32(Buffer.from("b"), zlib.crc32(Buffer.from("a")))
    ]);
    // zstd is left out until a consumer needs it (improvements/shim/plan.md
    // 5.3): none of Node's zstd exports is there, rather than a half
    test("zstd is not provided", () => {
        const zstd = Object.keys(nodeZlib).filter((k) => /zstd/i.test(k));
        assert.ok(zstd.length > 0);
        for (const name of zstd) {
            assert.equal((libZlib as any)[name], undefined, name);
        }
    });
    same("constants", ({ zlib }) => {
        const keys = [
            "Z_NO_FLUSH",
            "Z_PARTIAL_FLUSH",
            "Z_SYNC_FLUSH",
            "Z_FULL_FLUSH",
            "Z_FINISH",
            "Z_BLOCK",
            "Z_OK",
            "Z_STREAM_END",
            "Z_NEED_DICT",
            "Z_DATA_ERROR",
            "Z_BUF_ERROR",
            "Z_BEST_SPEED",
            "Z_BEST_COMPRESSION",
            "Z_DEFAULT_COMPRESSION",
            "Z_DEFAULT_STRATEGY",
            "BROTLI_PARAM_QUALITY",
            "BROTLI_OPERATION_FLUSH",
            "DEFLATE",
            "GZIP",
            "UNZIP"
        ];
        return keys.map((k) => [k, (zlib.constants as any)[k]]);
    });
    same("codes", ({ zlib }) => [
        (zlib as any).codes?.Z_DATA_ERROR,
        (zlib as any).codes?.["-3"]
    ]);
    same("exports", ({ zlib }) =>
        [
            "Deflate",
            "Inflate",
            "Gzip",
            "Gunzip",
            "DeflateRaw",
            "InflateRaw",
            "Unzip",
            "BrotliCompress",
            "BrotliDecompress",
            "createUnzip",
            "deflateRawSync",
            "inflateRawSync"
        ].map((k) => [k, typeof (zlib as any)[k]])
    );
});

// Stage 5: what the core module has to get right beyond the one-shots

// pieces of 1 to 3 bytes, the way a socket may deliver a packet
function pieces(bytes: Uint8Array) {
    const out: Uint8Array[] = [];
    for (let i = 0, at = 0; at < bytes.length; i++) {
        out.push(bytes.subarray(at, at + (i % 3) + 1));
        at += (i % 3) + 1;
    }
    return out;
}

function collect(stream: NodeJS.EventEmitter) {
    const chunks: Uint8Array[] = [];
    stream.on("data", (c: Uint8Array) => chunks.push(c));
    return chunks;
}

const concat = (chunks: Uint8Array[]) =>
    Buffer.concat(chunks.map((c) => Buffer.from(c)));

const ended = (stream: NodeJS.EventEmitter) =>
    new Promise((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
    });

const flushed = (stream: any, kind?: number) =>
    new Promise<void>((resolve) =>
        kind === undefined
            ? stream.flush(() => resolve())
            : stream.flush(kind, () => resolve())
    );

// the error as Node's zlib reports it, errno included
const failure = (e: any) => [e.name, e.code ?? null, e.errno ?? null];
function failureOf(fn: () => unknown) {
    try {
        fn();
        return "no error";
    } catch (e) {
        return failure(e);
    }
}

const DEFLATED = nodeZlib.deflateSync(TEXT);
const GZIPPED = nodeZlib.gzipSync(TEXT);
const RAW = nodeZlib.deflateRawSync(TEXT);
const BROTLI = nodeZlib.brotliCompressSync(TEXT);
const DICTIONARY = Buffer.from("quick brown fox");
const DEFLATED_DICT = nodeZlib.deflateSync(TEXT, { dictionary: DICTIONARY });
const RAW_DICT = nodeZlib.deflateRawSync(TEXT, { dictionary: DICTIONARY });

// Node's deflate driven as OpenSSH and ssh2 do: Z_PARTIAL_FLUSH after each
// packet, whose last bits (an empty fixed block) end up in the next one
const PACKETS = ["first packet", "second packet, a longer one", "third"];
const PARTIAL_PACKETS = (() => {
    const deflate: any = nodeZlib.createDeflate();
    return PACKETS.map((packet) => {
        const input = Buffer.from(packet);
        const out = Buffer.alloc(1024);
        deflate._handle.writeSync(
            nodeZlib.constants.Z_PARTIAL_FLUSH,
            input,
            0,
            input.length,
            out,
            0,
            out.length
        );
        return out.subarray(0, out.length - deflate._writeState[0]);
    });
})();

suite("shim zlib - flushes, params, reset", () => {
    same(
        "Z_SYNC_FLUSH in small pieces, both ways",
        async ({ zlib, Buffer }) => {
            const deflate = zlib.createDeflate();
            const inflate = zlib.createInflate();
            const compressed = collect(deflate);
            const out = collect(inflate);
            const results: boolean[] = [];
            for (let i = 0; i < 6; i++) {
                const packet = Buffer.from(
                    `packet ${i}: ${TEXT.slice(0, i * 13)}`
                );
                compressed.length = 0;
                out.length = 0;
                for (const p of pieces(packet)) deflate.write(p);
                await flushed(deflate, zlib.constants.Z_SYNC_FLUSH);
                for (const p of pieces(concat(compressed))) inflate.write(p);
                await flushed(inflate, zlib.constants.Z_SYNC_FLUSH);
                results.push(concat(out).equals(Buffer.from(packet)));
            }
            deflate.destroy();
            inflate.destroy();
            return results;
        }
    );
    same("Z_PARTIAL_FLUSH packets of Node's deflate", async ({ zlib }) => {
        const inflate = zlib.createInflate();
        const out = collect(inflate);
        const results: string[] = [];
        for (const packet of PARTIAL_PACKETS) {
            out.length = 0;
            inflate.write(packet);
            await flushed(inflate, zlib.constants.Z_SYNC_FLUSH);
            results.push(concat(out).toString());
        }
        inflate.destroy();
        return results;
    });
    // ssh2 (lib/protocol/zlib.js) uses the binding of createInflate()
    same("the binding as ssh2 drives it", ({ zlib, Buffer }) => {
        const { DEFLATE, INFLATE, Z_PARTIAL_FLUSH } = zlib.constants;
        const Handle = (zlib.createInflate() as any)._handle.constructor;
        const open = (mode: number) => {
            const state = new Uint32Array(2);
            const handle = new Handle(mode);
            const z = { handle, state, error: null as unknown };
            handle.onerror = (message: string, errno: number, code: string) =>
                (z.error = [typeof message, code, errno]);
            handle.init(15, -1, 8, 0, state, () => {}, undefined);
            return z;
        };
        // ssh2's Zlib.writeSync loop, with a small output buffer
        const write = (z: ReturnType<typeof open>, chunk: Uint8Array) => {
            const chunkSize = 16;
            const outs: Buffer[] = [];
            let availInBefore = chunk.length;
            let availOutBefore = chunkSize;
            let inOff = 0;
            let offset = 0;
            let buffer = Buffer.alloc(chunkSize);
            while (true) {
                z.handle.writeSync(
                    Z_PARTIAL_FLUSH,
                    chunk,
                    inOff,
                    availInBefore,
                    buffer,
                    offset,
                    availOutBefore
                );
                if (z.error) return null;
                const [availOutAfter, availInAfter] = z.state;
                const have = availOutBefore - availOutAfter;
                outs.push(Buffer.from(buffer.subarray(offset, offset + have)));
                offset += have;
                if (availOutAfter === 0 || offset >= chunkSize) {
                    availOutBefore = chunkSize;
                    offset = 0;
                    buffer = Buffer.alloc(chunkSize);
                }
                if (availOutAfter !== 0) break;
                inOff += availInBefore - availInAfter;
                availInBefore = availInAfter;
            }
            return Buffer.concat(outs);
        };
        const deflater = open(DEFLATE);
        const inflater = open(INFLATE);
        const results: unknown[] = [];
        for (const packet of [...PACKETS, TEXT.slice(0, 3000)]) {
            const compressed = write(deflater, Buffer.from(packet))!;
            results.push(write(inflater, compressed)?.toString() === packet);
        }
        const fromNode = open(INFLATE);
        for (const packet of PARTIAL_PACKETS) {
            results.push(write(fromNode, packet)?.toString());
        }
        const bad = open(INFLATE);
        write(bad, Buffer.from("not deflate"));
        results.push(bad.error);
        for (const z of [deflater, inflater, fromNode, bad]) z.handle.close();
        return results;
    });
    same("flush() callback", async ({ zlib, Buffer }) => {
        const deflate = zlib.createDeflate();
        const chunks = collect(deflate);
        deflate.write(Buffer.from(TEXT.slice(0, 1000)));
        await flushed(deflate);
        const sofar = nodeZlib
            .inflateSync(concat(chunks), {
                finishFlush: nodeZlib.constants.Z_SYNC_FLUSH
            })
            .toString();
        const done = ended(deflate);
        deflate.end();
        await done;
        // after the end: the callback waits for 'end' or runs at once
        await flushed(deflate);
        return sofar === TEXT.slice(0, 1000);
    });
    same("params() mid-stream", async ({ zlib, Buffer }) => {
        const deflate = zlib.createDeflate({ level: 1 });
        const chunks = collect(deflate);
        const { Z_DEFAULT_STRATEGY, Z_HUFFMAN_ONLY } = zlib.constants;
        deflate.write(Buffer.from(TEXT));
        await new Promise<void>((resolve) =>
            deflate.params(9, Z_DEFAULT_STRATEGY, () => resolve())
        );
        deflate.write(Buffer.from(TEXT));
        await new Promise<void>((resolve) =>
            deflate.params(5, Z_HUFFMAN_ONLY, () => resolve())
        );
        // the same values again: the callback, nothing else
        await new Promise<void>((resolve) =>
            deflate.params(5, Z_HUFFMAN_ONLY, () => resolve())
        );
        const done = ended(deflate);
        deflate.end(Buffer.from(TEXT));
        await done;
        return [
            nodeZlib.inflateSync(concat(chunks)).toString() === TEXT.repeat(3),
            failureOf(() => deflate.params(12, 0, () => {}))
        ];
    });
    same("reset()", async ({ zlib, Buffer }) => {
        const deflate = zlib.createDeflate();
        const chunks = collect(deflate);
        deflate.write(Buffer.from("hello"));
        await flushed(deflate, zlib.constants.Z_SYNC_FLUSH);
        const before = chunks.length;
        deflate.reset();
        const done = ended(deflate);
        deflate.end(Buffer.from("world"));
        await done;
        const afterReset = nodeZlib
            .inflateSync(concat(chunks.slice(before)))
            .toString();

        const gunzip = zlib.createGunzip();
        const out = collect(gunzip);
        gunzip.write(GZIPPED.subarray(0, 40));
        await flushed(gunzip, zlib.constants.Z_SYNC_FLUSH);
        // reset() of Gunzip is not in @types/node
        (gunzip as any).reset();
        out.length = 0;
        const gunzipped = ended(gunzip);
        gunzip.end(GZIPPED);
        await gunzipped;
        return [afterReset, concat(out).toString() === TEXT];
    });
    same("brotli flush in a stream", async ({ zlib, Buffer }) => {
        const compress = zlib.createBrotliCompress();
        const decompress = zlib.createBrotliDecompress();
        const compressed = collect(compress);
        const out = collect(decompress);
        const results: boolean[] = [];
        for (const packet of PACKETS) {
            compressed.length = 0;
            out.length = 0;
            compress.write(Buffer.from(packet));
            await flushed(compress);
            decompress.write(concat(compressed));
            await flushed(decompress);
            results.push(concat(out).toString() === packet);
        }
        compress.destroy();
        decompress.destroy();
        return results;
    });
});

suite("shim zlib - errors", () => {
    same("zlib errors: code and errno", ({ zlib, Buffer }) => {
        const flip = (b: Uint8Array, i: number) => {
            const c = Buffer.from(b);
            c[(i + c.length) % c.length] ^= 1;
            return c;
        };
        return [
            failureOf(() => zlib.inflateSync(DEFLATED.subarray(0, 50))),
            failureOf(() =>
                zlib.gunzipSync(GZIPPED.subarray(0, GZIPPED.length - 3))
            ),
            failureOf(() => zlib.inflateRawSync(Buffer.alloc(0))),
            failureOf(() => zlib.inflateSync(Buffer.from([1, 2, 3, 4]))),
            failureOf(() => zlib.unzipSync(Buffer.from("plain"))),
            failureOf(() => zlib.unzipSync(Buffer.from("x"))),
            failureOf(() => zlib.inflateSync(Buffer.from([0x79, 0x18, 1, 2]))),
            failureOf(() => zlib.inflateSync(DEFLATED, { windowBits: 9 })),
            failureOf(() => zlib.inflateSync(DEFLATED_DICT)),
            failureOf(() =>
                zlib.inflateSync(DEFLATED_DICT, {
                    dictionary: Buffer.from("other")
                })
            ),
            failureOf(() => zlib.inflateRawSync(RAW_DICT)),
            failureOf(() => zlib.inflateSync(flip(DEFLATED, -1))),
            failureOf(() => zlib.gunzipSync(flip(GZIPPED, -6))),
            failureOf(() => zlib.gunzipSync(flip(GZIPPED, -1))),
            failureOf(() =>
                zlib.gunzipSync(
                    Buffer.concat([GZIPPED, Buffer.from("garbage")])
                )
            ),
            failureOf(() =>
                zlib.gunzipSync(Buffer.concat([GZIPPED, Buffer.from([0x1f])]))
            ),
            failureOf(() => zlib.brotliDecompressSync(BROTLI.subarray(0, 20))),
            failureOf(() =>
                zlib.brotliDecompressSync(Buffer.from("hello world garbage"))
            )
        ];
    });
    same("errors through callbacks", async ({ zlib, Buffer }) => {
        const errorOf = (fn: Function, data: Uint8Array, options = {}) =>
            new Promise((resolve) =>
                fn(data, options, (e: any) =>
                    resolve(e ? failure(e) : "no error")
                )
            );
        return [
            await errorOf(zlib.inflate, Buffer.from([1, 2, 3, 4])),
            await errorOf(zlib.gunzip, GZIPPED.subarray(0, 30)),
            await errorOf(zlib.inflate, DEFLATED_DICT),
            await errorOf(
                zlib.brotliDecompress,
                Buffer.from("hello world garbage")
            ),
            await errorOf(zlib.inflate, DEFLATED, { maxOutputLength: 100 }),
            await errorOf(zlib.deflate, Buffer.from(TEXT), {
                maxOutputLength: 10
            })
        ];
    });
    same("stream errors", async ({ zlib, Buffer }) => {
        const errorOf = async (stream: any, data: Uint8Array) => {
            stream.resume();
            const error = new Promise((resolve) =>
                stream.on("error", (e: any) => resolve(failure(e)))
            );
            stream.end(data);
            return error;
        };
        return [
            await errorOf(zlib.createInflate(), DEFLATED.subarray(0, 50)),
            await errorOf(zlib.createGunzip(), Buffer.from("not gzip")),
            await errorOf(
                zlib.createGunzip(),
                Buffer.concat([GZIPPED, Buffer.from("garbage")])
            ),
            await errorOf(zlib.createInflate(), Buffer.alloc(0))
        ];
    });
    same("option and argument validation", ({ zlib, Buffer }) => {
        const data = Buffer.from("x");
        return [
            failureOf(() => zlib.deflateSync(data, { level: 12 })),
            failureOf(() => zlib.deflateSync(data, { level: "1" as any })),
            failureOf(() => zlib.deflateSync(data, { windowBits: 20 })),
            failureOf(() => zlib.gzipSync(data, { windowBits: 8 })),
            failureOf(() => zlib.deflateSync(data, { memLevel: 0 })),
            failureOf(() => zlib.deflateSync(data, { strategy: 9 })),
            failureOf(() => zlib.deflateSync(data, { chunkSize: 10 })),
            failureOf(() => zlib.deflateSync(data, { flush: 9 })),
            failureOf(() => zlib.deflateSync(data, { maxOutputLength: 0 })),
            failureOf(() =>
                zlib.deflateSync(data, { dictionary: "dict" as any })
            ),
            failureOf(() => zlib.deflateSync(5 as any)),
            failureOf(() => zlib.deflate(5 as any, () => {})),
            failureOf(() => zlib.deflate(data, {}, undefined as any)),
            failureOf(() =>
                zlib.brotliCompressSync(data, { params: { 100: 1 } })
            ),
            failureOf(() =>
                zlib.brotliCompressSync(data, {
                    params: {
                        [zlib.constants.BROTLI_PARAM_QUALITY]: "4" as any
                    }
                })
            ),
            failureOf(() => zlib.createBrotliCompress({ flush: 4 }))
        ];
    });
});

suite("shim zlib - more", () => {
    same("trailing data", ({ zlib, Buffer }) => {
        const garbage = Buffer.from("garbage");
        return [
            zlib.inflateSync(Buffer.concat([DEFLATED, garbage])).length,
            zlib.inflateRawSync(Buffer.concat([RAW, garbage])).length,
            zlib.brotliDecompressSync(Buffer.concat([BROTLI, garbage])).length,
            zlib.gunzipSync(Buffer.concat([GZIPPED, Buffer.alloc(10)])).length,
            zlib.gunzipSync(Buffer.concat([GZIPPED, Buffer.alloc(1), garbage]))
                .length
        ];
    });
    same("writes after the end of the data", async ({ zlib, Buffer }) => {
        const inflate = zlib.createInflate();
        const out = collect(inflate);
        const done = ended(inflate);
        inflate.write(DEFLATED);
        inflate.write(Buffer.from("garbage"));
        inflate.end();
        await done;
        return concat(out).length;
    });
    same("unzip of both formats", async ({ zlib }) => {
        const streamed = async (data: Uint8Array) => {
            const unzip = zlib.createUnzip();
            const out = collect(unzip);
            const done = ended(unzip);
            unzip.end(data);
            await done;
            return concat(out).toString() === TEXT;
        };
        return [
            zlib.unzipSync(GZIPPED).toString() === TEXT,
            zlib.unzipSync(DEFLATED).toString() === TEXT,
            await streamed(GZIPPED),
            await streamed(DEFLATED)
        ];
    });
    same("end of a truncated stream", async ({ zlib }) => {
        const inflate = zlib.createInflate({
            finishFlush: zlib.constants.Z_SYNC_FLUSH
        });
        const out = collect(inflate);
        const done = ended(inflate);
        inflate.end(DEFLATED.subarray(0, 60));
        await done;
        return concat(out).length;
    });
    same("empty streams", async ({ zlib }) => {
        const gzip = zlib.createGzip();
        const out = collect(gzip);
        const done = ended(gzip);
        gzip.end();
        await done;
        return nodeZlib.gunzipSync(concat(out)).length;
    });
    same("maxOutputLength on streams and callbacks", async ({ zlib }) => {
        const inflate = zlib.createInflate({ maxOutputLength: 100 });
        const out = collect(inflate);
        const done = ended(inflate);
        inflate.end(DEFLATED);
        await done;
        const exact = await new Promise((resolve) =>
            zlib.inflate(
                DEFLATED,
                { maxOutputLength: TEXT.length + 4 },
                (e, r) => resolve(e ? failure(e) : r.length)
            )
        );
        return [concat(out).length, exact];
    });
    same("dictionary on streams", async ({ zlib, Buffer }) => {
        const dictionary = new Uint8Array(DICTIONARY).buffer;
        const deflate = zlib.createDeflate({ dictionary });
        const inflate = zlib.createInflate({
            dictionary: Buffer.from(DICTIONARY)
        });
        const out = collect(inflate);
        const done = ended(inflate);
        deflate.pipe(inflate);
        deflate.end(Buffer.from(TEXT));
        await done;
        return concat(out).toString() === TEXT;
    });
    same("brotli params", ({ zlib, Buffer }) => {
        const P = zlib.constants;
        return [
            { [P.BROTLI_PARAM_QUALITY]: 0 },
            { [P.BROTLI_PARAM_QUALITY]: 5, [P.BROTLI_PARAM_LGWIN]: 10 },
            {
                [P.BROTLI_PARAM_MODE]: P.BROTLI_MODE_TEXT,
                [P.BROTLI_PARAM_SIZE_HINT]: TEXT.length
            },
            { [P.BROTLI_PARAM_QUALITY]: 11, [P.BROTLI_PARAM_LGWIN]: 24 }
        ].map(
            (params) =>
                nodeZlib
                    .brotliDecompressSync(
                        zlib.brotliCompressSync(Buffer.from(TEXT), { params })
                    )
                    .toString() === TEXT
        );
    });
    same("crc32 incremental", ({ zlib, Buffer }) => {
        const data = Buffer.from(TEXT);
        let crc = 0;
        for (let i = 0; i < data.length; i += 1000) {
            crc = zlib.crc32(data.subarray(i, i + 1000), crc);
        }
        return [
            crc,
            zlib.crc32(data),
            zlib.crc32(""),
            zlib.crc32("€", 12345),
            zlib.crc32(new Uint16Array([1, 2, 3])),
            zlib.crc32(new DataView(new ArrayBuffer(8))),
            failureOf(() => zlib.crc32(5 as any)),
            failureOf(() => zlib.crc32("x", -1)),
            failureOf(() => zlib.crc32("x", 1.5))
        ];
    });
    same("bytesWritten, close() and _closed", async ({ zlib }) => {
        const gzip: any = zlib.createGzip();
        gzip.resume();
        const done = ended(gzip);
        gzip.write("12345");
        gzip.end("678");
        await done;
        const deflate: any = zlib.createDeflate();
        const before = deflate._closed;
        const closed = await new Promise((resolve) =>
            deflate.close((e: any) => resolve(e ? failure(e) : "closed"))
        );
        return [
            gzip.bytesWritten,
            gzip.bytesRead,
            before,
            deflate._closed,
            closed
        ];
    });
    same("_processChunk", ({ zlib, Buffer }) => {
        const deflate: any = zlib.createDeflate();
        const out = deflate._processChunk(
            Buffer.from(TEXT),
            zlib.constants.Z_FINISH
        );
        return [
            decoded("deflateSync", out),
            deflate._closed,
            deflate.bytesWritten
        ];
    });
    same("info option in callbacks", async ({ zlib, Buffer }) => {
        const result: any = await new Promise((resolve, reject) =>
            zlib.deflate(Buffer.from("x"), { info: true }, (e: any, r: any) =>
                e ? reject(e) : resolve(r)
            )
        );
        return [
            decoded("deflateSync", result.buffer),
            result.engine instanceof zlib.Deflate
        ];
    });
    same("classes", ({ zlib }) => {
        class Mine extends zlib.Gzip {}
        const mine = new Mine();
        return [
            mine instanceof zlib.Gzip,
            new zlib.Inflate() instanceof zlib.Inflate,
            typeof (zlib.createInflate() as any)._handle.constructor,
            zlib.Deflate.name,
            Object.keys((zlib as any).codes).length
        ];
    });
});
