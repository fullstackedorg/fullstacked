// nodejs source: https://nodejs.org/docs/latest/api/zlib.html
//
// Node's zlib (Node 24, lib/zlib.js) over the core's Zlib module
// (core/internal/zlib), improvements/shim/plan.md Stage 5. The sync one-shots are one sync
// core call; the callback forms one async call, so the compression runs off
// the JS thread; the streams are Transforms of lib/stream whose _transform
// is one async StreamWrite per chunk. The classes are function constructors
// as in Node (and lib/stream), so that `Deflate.call(this)` works.
//
// Not provided: zstd (improvements/shim/plan.md 5.3: until a consumer needs it). Different
// from Node: the compressed bytes (Go's compress/flate and andybalholm/brotli
// are not zlib and libbrotli; every stream is valid and Node decodes it);
// Z_FILTERED, Z_RLE, Z_FIXED and memLevel are accepted and compress as the
// defaults; windowBits < 15 compresses with Huffman coding only; Z_FULL_FLUSH
// flushes as Z_SYNC_FLUSH (the match window is kept); the brotli mode and
// size hint are not used; the message of an error in deflate data is
// generic (its code and errno are zlib's); streams emit the output of a
// write as one chunk (no chunkSize slicing).

import type * as NodeZlib from "node:zlib";
import { Buffer } from "buffer";
import { Transform, finished } from "stream";
import { constants } from "./constants.ts";
import { crc32 } from "./crc32.ts";
import { type CoreOptions, ZlibHandle } from "./handle.ts";
import { invalidArgType, validateFunction } from "../util/internal.ts";
import { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE } from "../buffer/errors.ts";

const {
    BROTLI_DECODE,
    BROTLI_ENCODE,
    BROTLI_OPERATION_EMIT_METADATA,
    BROTLI_OPERATION_FINISH,
    BROTLI_OPERATION_FLUSH,
    BROTLI_OPERATION_PROCESS,
    BROTLI_PARAM_LGWIN,
    BROTLI_PARAM_QUALITY,
    DEFLATE,
    DEFLATERAW,
    GUNZIP,
    GZIP,
    INFLATE,
    INFLATERAW,
    UNZIP,
    Z_BLOCK,
    Z_DEFAULT_CHUNK,
    Z_DEFAULT_COMPRESSION,
    Z_DEFAULT_MEMLEVEL,
    Z_DEFAULT_STRATEGY,
    Z_DEFAULT_WINDOWBITS,
    Z_FINISH,
    Z_FIXED,
    Z_FULL_FLUSH,
    Z_MAX_LEVEL,
    Z_MAX_MEMLEVEL,
    Z_MAX_WINDOWBITS,
    Z_MIN_CHUNK,
    Z_MIN_LEVEL,
    Z_MIN_MEMLEVEL,
    Z_MIN_WINDOWBITS,
    Z_NO_FLUSH,
    Z_PARTIAL_FLUSH,
    Z_SYNC_FLUSH
} = constants;

// buffer.kMaxLength
const kMaxLength = 2 ** 53 - 1;

const kFlushFlag = Symbol("kFlushFlag");
const kError = Symbol("kError");

export const codes: Record<string | number, string | number> = {
    Z_OK: constants.Z_OK,
    Z_STREAM_END: constants.Z_STREAM_END,
    Z_NEED_DICT: constants.Z_NEED_DICT,
    Z_ERRNO: constants.Z_ERRNO,
    Z_STREAM_ERROR: constants.Z_STREAM_ERROR,
    Z_DATA_ERROR: constants.Z_DATA_ERROR,
    Z_MEM_ERROR: constants.Z_MEM_ERROR,
    Z_BUF_ERROR: constants.Z_BUF_ERROR,
    Z_VERSION_ERROR: constants.Z_VERSION_ERROR
};
for (const key of Object.keys(codes)) codes[codes[key]] = key;
Object.freeze(codes);

// errors

function nodeError<E extends Error>(error: E, code: string) {
    return Object.assign(error, { code });
}

const ERR_BUFFER_TOO_LARGE = (max: number) =>
    nodeError(
        new RangeError(`Cannot create a Buffer larger than ${max} bytes`),
        "ERR_BUFFER_TOO_LARGE"
    );

const ERR_BROTLI_INVALID_PARAM = (key: string) =>
    nodeError(
        new RangeError(`${key} is not a valid Brotli parameter`),
        "ERR_BROTLI_INVALID_PARAM"
    );

const ERR_INTERNAL_ASSERTION = (message: string) =>
    nodeError(new Error(message), "ERR_INTERNAL_ASSERTION");

// options

// Node's checkFiniteNumber: undefined and NaN read as "not given"
function checkFiniteNumber(number: unknown, name: string) {
    if (number === undefined) return false;
    if (Number.isFinite(number)) return true;
    if (Number.isNaN(number)) return false;
    if (typeof number !== "number") {
        throw ERR_INVALID_ARG_TYPE(name, "number", number);
    }
    throw ERR_OUT_OF_RANGE(name, "a finite number", number);
}

function checkRangesOrGetDefault(
    number: unknown,
    name: string,
    lower: number,
    upper: number,
    def?: number
) {
    if (!checkFiniteNumber(number, name)) return def;
    if ((number as number) < lower || (number as number) > upper) {
        throw ERR_OUT_OF_RANGE(name, `>= ${lower} and <= ${upper}`, number);
    }
    return number as number;
}

// the flush values allowed for each kind of stream
const FLUSH_BOUNDS = {
    zlib: [Z_NO_FLUSH, Z_BLOCK],
    brotli: [BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_EMIT_METADATA]
};

// Node orders the flush values by how much they flush (and applies the same
// order to brotli's operations)
const flushiness: number[] = [];
[
    Z_NO_FLUSH,
    Z_BLOCK,
    Z_PARTIAL_FLUSH,
    Z_SYNC_FLUSH,
    Z_FULL_FLUSH,
    Z_FINISH
].forEach((flag, i) => (flushiness[flag] = i));
const maxFlush = (a: number, b: number) =>
    flushiness[a] > flushiness[b] ? a : b;

// zero-length chunks that carry a flush through the writable side
const kFlushBuffers: Buffer[] = [];
for (const flag of [
    Z_NO_FLUSH,
    Z_BLOCK,
    Z_PARTIAL_FLUSH,
    Z_SYNC_FLUSH,
    Z_FULL_FLUSH,
    Z_FINISH
]) {
    kFlushBuffers[flag] = Object.assign(Buffer.alloc(0), {
        [kFlushFlag]: flag
    });
}

function toDictionary(dictionary: unknown) {
    if (dictionary === undefined || ArrayBuffer.isView(dictionary)) {
        return dictionary as ArrayBufferView | undefined;
    }
    if (isAnyArrayBuffer(dictionary)) return Buffer.from(dictionary);
    throw ERR_INVALID_ARG_TYPE(
        "options.dictionary",
        ["Buffer", "TypedArray", "DataView", "ArrayBuffer"],
        dictionary
    );
}

const isAnyArrayBuffer = (value: unknown): value is ArrayBuffer =>
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer);

const asBytes = (view: ArrayBufferView) =>
    view instanceof Uint8Array
        ? view
        : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

// ZlibBase: what the zlib and brotli streams share

type FlushDefaults = { flush: number; finishFlush: number; fullFlush: number };

function ZlibBase(
    this: any,
    opts: any,
    mode: number,
    handle: ZlibHandle,
    { flush, finishFlush, fullFlush }: FlushDefaults
) {
    let chunkSize = Z_DEFAULT_CHUNK;
    let maxOutputLength = kMaxLength;
    const bounds =
        mode === BROTLI_ENCODE || mode === BROTLI_DECODE
            ? FLUSH_BOUNDS.brotli
            : FLUSH_BOUNDS.zlib;
    if (opts) {
        chunkSize = opts.chunkSize;
        if (!checkFiniteNumber(chunkSize, "options.chunkSize")) {
            chunkSize = Z_DEFAULT_CHUNK;
        } else if (chunkSize < Z_MIN_CHUNK) {
            throw ERR_OUT_OF_RANGE(
                "options.chunkSize",
                `>= ${Z_MIN_CHUNK}`,
                chunkSize
            );
        }
        flush = checkRangesOrGetDefault(
            opts.flush,
            "options.flush",
            bounds[0],
            bounds[1],
            flush
        );
        finishFlush = checkRangesOrGetDefault(
            opts.finishFlush,
            "options.finishFlush",
            bounds[0],
            bounds[1],
            finishFlush
        );
        maxOutputLength = checkRangesOrGetDefault(
            opts.maxOutputLength,
            "options.maxOutputLength",
            1,
            kMaxLength,
            kMaxLength
        );
        if (opts.encoding || opts.objectMode || opts.writableObjectMode) {
            opts = {
                ...opts,
                encoding: null,
                objectMode: false,
                writableObjectMode: false
            };
        }
    }
    (Transform as any).call(this, { autoDestroy: true, ...opts });
    this[kError] = null;
    this.bytesWritten = 0;
    this._handle = handle;
    handle._owner = this;
    this._chunkSize = chunkSize;
    this._defaultFlushFlag = flush;
    this._finishFlushFlag = finishFlush;
    this._defaultFullFlushFlag = fullFlush;
    this._info = opts?.info;
    this._maxOutputLength = maxOutputLength;
}
Object.setPrototypeOf(ZlibBase.prototype, Transform.prototype);
Object.setPrototypeOf(ZlibBase, Transform);

const base = ZlibBase.prototype as any;

Object.defineProperty(base, "_closed", {
    configurable: true,
    enumerable: true,
    get(this: any) {
        return !this._handle;
    }
});

base.reset = function (this: any) {
    if (!this._handle) throw ERR_INTERNAL_ASSERTION("zlib binding closed");
    return this._handle.reset();
};

// the end of the input is a finishing flush, as _transform gives the last
// chunk
base._flush = function (this: any, callback: (error?: Error) => void) {
    this._transform(Buffer.alloc(0), "", callback);
};

base._final = function (callback: () => void) {
    callback();
};

base.flush = function (this: any, kind?: any, callback?: () => void) {
    if (typeof kind === "function" || (kind === undefined && !callback)) {
        callback = kind;
        kind = this._defaultFullFlushFlag;
    }
    if (this.writableFinished) {
        if (callback) queueMicrotask(callback);
    } else if (this.writableEnded) {
        if (callback) this.once("end", callback);
    } else {
        this.write(kFlushBuffers[kind], "", callback);
    }
};

base.close = function (this: any, callback?: (error?: Error) => void) {
    if (callback) finished(this, callback);
    this.destroy();
};

base._destroy = function (
    this: any,
    error: Error | null,
    callback: (error: Error | null) => void
) {
    closeHandle(this);
    callback(error);
};

base._transform = function (
    this: any,
    chunk: any,
    _encoding: string,
    callback: (error?: Error) => void
) {
    let flushFlag = this._defaultFlushFlag;
    if (typeof chunk[kFlushFlag] === "number") flushFlag = chunk[kFlushFlag];
    // the last chunk carries the finishing flush
    if (this.writableEnded && this.writableLength === chunk.byteLength) {
        flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
    }
    processChunk(this, chunk, flushFlag, callback);
};

// kept by Node for the packages that called it before streams had flush()
base._processChunk = function (
    this: any,
    chunk: Uint8Array,
    flushFlag: number,
    callback?: (error?: Error) => void
) {
    if (typeof callback === "function") {
        processChunk(this, chunk, flushFlag, callback);
    } else {
        return processChunkSync(this, chunk, flushFlag);
    }
};

function closeHandle(engine: any) {
    if (!engine._handle) return;
    engine._handle.close();
    engine._handle = null;
}

function onError(engine: any, error: Error) {
    engine[kError] = error;
    engine.destroy(error);
}

// one async StreamWrite; the write callback once its output is pushed
function processChunk(
    engine: any,
    chunk: Uint8Array,
    flushFlag: number,
    callback: (error?: Error) => void
) {
    const handle: ZlibHandle | null = engine._handle;
    if (!handle) {
        queueMicrotask(() => callback());
        return;
    }
    handle.write(chunk, flushFlag).then(
        (out) => {
            if (engine.destroyed) return callback();
            engine.bytesWritten += chunk.byteLength;
            if (out.byteLength > 0) engine.push(out);
            callback();
        },
        (error) => onError(engine, error)
    );
}

// Node's processChunkSync: all of chunk at once, then the handle is closed.
// A handle never written to (the sync one-shots) is one Compress or
// Decompress call.
function processChunkSync(engine: any, chunk: Uint8Array, flushFlag: number) {
    const handle: ZlibHandle | null = engine._handle;
    if (!handle) throw ERR_INTERNAL_ASSERTION("zlib binding closed");
    const max: number = engine._maxOutputLength;
    let out: Buffer;
    try {
        if (handle.opened) {
            out = handle.writeAllSync(chunk, flushFlag);
            if (out.byteLength > max) throw ERR_BUFFER_TOO_LARGE(max);
        } else {
            out = handle.oneShotSync(chunk, oneShotOptions(engine, flushFlag));
        }
    } catch (error) {
        engine[kError] = error;
        closeHandle(engine);
        throw error;
    }
    engine.bytesWritten = chunk.byteLength;
    closeHandle(engine);
    return out;
}

function oneShotOptions(engine: any, flushFlag: number): CoreOptions {
    const max: number = engine._maxOutputLength;
    return {
        finishFlush: flushFlag,
        ...(max < kMaxLength ? { maxOutputLength: max } : {})
    };
}

// Zlib: the deflate and gzip streams

const zlibDefaultOpts: FlushDefaults = {
    flush: Z_NO_FLUSH,
    finishFlush: Z_FINISH,
    fullFlush: Z_FULL_FLUSH
};

function Zlib(this: any, opts: any, mode: number) {
    let windowBits = Z_DEFAULT_WINDOWBITS;
    let level = Z_DEFAULT_COMPRESSION;
    let memLevel = Z_DEFAULT_MEMLEVEL;
    let strategy = Z_DEFAULT_STRATEGY;
    let dictionary: ArrayBufferView | undefined;
    if (opts) {
        // on the decompression side, 0 (or nothing) means the window of
        // the stream's header
        if (
            (opts.windowBits == null || opts.windowBits === 0) &&
            (mode === INFLATE || mode === GUNZIP || mode === UNZIP)
        ) {
            windowBits = 0;
        } else {
            // { windowBits: 8 } is valid for deflate, not for gzip
            windowBits = checkRangesOrGetDefault(
                opts.windowBits,
                "options.windowBits",
                Z_MIN_WINDOWBITS + (mode === GZIP ? 1 : 0),
                Z_MAX_WINDOWBITS,
                Z_DEFAULT_WINDOWBITS
            );
        }
        level = checkRangesOrGetDefault(
            opts.level,
            "options.level",
            Z_MIN_LEVEL,
            Z_MAX_LEVEL,
            Z_DEFAULT_COMPRESSION
        );
        memLevel = checkRangesOrGetDefault(
            opts.memLevel,
            "options.memLevel",
            Z_MIN_MEMLEVEL,
            Z_MAX_MEMLEVEL,
            Z_DEFAULT_MEMLEVEL
        );
        strategy = checkRangesOrGetDefault(
            opts.strategy,
            "options.strategy",
            Z_DEFAULT_STRATEGY,
            Z_FIXED,
            Z_DEFAULT_STRATEGY
        );
        dictionary = toDictionary(opts.dictionary);
    }
    const handle = new ZlibHandle(mode);
    this._writeState = new Uint32Array(2);
    handle.init(
        windowBits,
        level,
        memLevel,
        strategy,
        this._writeState,
        undefined,
        dictionary && asBytes(dictionary)
    );
    ZlibBase.call(this, opts, mode, handle, zlibDefaultOpts);
    this._level = level;
    this._strategy = strategy;
    this._mode = mode;
}
Object.setPrototypeOf(Zlib.prototype, ZlibBase.prototype);
Object.setPrototypeOf(Zlib, ZlibBase);

// params() flushes what was written with the old ones first
(Zlib.prototype as any).params = function (
    this: any,
    level: number,
    strategy: number,
    callback?: () => void
) {
    checkRangesOrGetDefault(level, "level", Z_MIN_LEVEL, Z_MAX_LEVEL);
    checkRangesOrGetDefault(strategy, "strategy", Z_DEFAULT_STRATEGY, Z_FIXED);
    if (this._level === level && this._strategy === strategy) {
        if (callback) queueMicrotask(callback);
        return;
    }
    this.flush(Z_SYNC_FLUSH, () => {
        if (!this._handle) {
            throw ERR_INTERNAL_ASSERTION("zlib binding closed");
        }
        try {
            const out = this._handle.paramsSync(level, strategy);
            if (out.byteLength > 0) this.push(out);
        } catch (error) {
            return onError(this, error as Error);
        }
        if (!this.destroyed) {
            this._level = level;
            this._strategy = strategy;
            if (callback) callback();
        }
    });
};

// Brotli: the brotli streams

const brotliDefaultOpts: FlushDefaults = {
    flush: BROTLI_OPERATION_PROCESS,
    finishFlush: BROTLI_OPERATION_FINISH,
    fullFlush: BROTLI_OPERATION_FLUSH
};

const kMaxBrotliParam = Math.max(
    ...Object.entries(constants).map(([key, value]) =>
        key.startsWith("BROTLI_PARAM_") ? value : 0
    )
);

// the encoder's parameters the core uses: quality and window (mode, block
// size, size hint and the others are accepted and left to the encoder)
function brotliOptions(params: any): CoreOptions {
    const options: CoreOptions = {};
    if (!params) return options;
    const seen = new Set<number>();
    for (const origKey of Object.keys(params)) {
        const key = +origKey;
        if (
            Number.isNaN(key) ||
            key < 0 ||
            key > kMaxBrotliParam ||
            seen.has(key)
        ) {
            throw ERR_BROTLI_INVALID_PARAM(origKey);
        }
        seen.add(key);
        const value = params[origKey];
        if (typeof value !== "number" && typeof value !== "boolean") {
            throw ERR_INVALID_ARG_TYPE("options.params[key]", "number", value);
        }
        if (key === BROTLI_PARAM_QUALITY) {
            options.quality = Math.min(Math.max(Number(value), 0), 11);
        } else if (key === BROTLI_PARAM_LGWIN) {
            options.lgwin = Math.min(Math.max(Number(value), 10), 24);
        }
    }
    return options;
}

function Brotli(this: any, opts: any, mode: number) {
    const handle = new ZlibHandle(mode);
    handle.options = brotliOptions(opts?.params);
    this._writeState = new Uint32Array(2);
    ZlibBase.call(this, opts, mode, handle, brotliDefaultOpts);
}
Object.setPrototypeOf(Brotli.prototype, ZlibBase.prototype);
Object.setPrototypeOf(Brotli, ZlibBase);

// the classes

function zlibClass(name: string, mode: number, parent: Function) {
    const ctor = {
        [name]: function (this: any, opts?: any): any {
            if (!(this instanceof ctor)) return new (ctor as any)(opts);
            parent.call(this, opts, mode);
        }
    }[name];
    Object.setPrototypeOf(ctor.prototype, parent.prototype);
    Object.setPrototypeOf(ctor, parent);
    return ctor as any;
}

export const Deflate: typeof NodeZlib.Deflate = zlibClass(
    "Deflate",
    DEFLATE,
    Zlib
);
export const Inflate: typeof NodeZlib.Inflate = zlibClass(
    "Inflate",
    INFLATE,
    Zlib
);
export const Gzip: typeof NodeZlib.Gzip = zlibClass("Gzip", GZIP, Zlib);
export const Gunzip: typeof NodeZlib.Gunzip = zlibClass("Gunzip", GUNZIP, Zlib);
export const DeflateRaw: typeof NodeZlib.DeflateRaw = zlibClass(
    "DeflateRaw",
    DEFLATERAW,
    Zlib
);
export const InflateRaw: typeof NodeZlib.InflateRaw = zlibClass(
    "InflateRaw",
    INFLATERAW,
    Zlib
);
export const Unzip: typeof NodeZlib.Unzip = zlibClass("Unzip", UNZIP, Zlib);
export const BrotliCompress: typeof NodeZlib.BrotliCompress = zlibClass(
    "BrotliCompress",
    BROTLI_ENCODE,
    Brotli
);
export const BrotliDecompress: typeof NodeZlib.BrotliDecompress = zlibClass(
    "BrotliDecompress",
    BROTLI_DECODE,
    Brotli
);

export const createDeflate = (o?: any) => new Deflate(o);
export const createInflate = (o?: any) => new Inflate(o);
export const createGzip = (o?: any) => new Gzip(o);
export const createGunzip = (o?: any) => new Gunzip(o);
export const createDeflateRaw = (o?: any) => new DeflateRaw(o);
export const createInflateRaw = (o?: any) => new InflateRaw(o);
export const createUnzip = (o?: any) => new Unzip(o);
export const createBrotliCompress = (o?: any) => new BrotliCompress(o);
export const createBrotliDecompress = (o?: any) => new BrotliDecompress(o);

// the one-shots

const BUFFER_TYPES = [
    "string",
    "Buffer",
    "TypedArray",
    "DataView",
    "ArrayBuffer"
];

function zlibBufferSync(engine: any, buffer: unknown) {
    let bytes: Uint8Array;
    if (typeof buffer === "string") {
        bytes = Buffer.from(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
        bytes = asBytes(buffer);
    } else if (isAnyArrayBuffer(buffer)) {
        bytes = new Uint8Array(buffer);
    } else {
        throw ERR_INVALID_ARG_TYPE("buffer", BUFFER_TYPES, buffer);
    }
    const out = processChunkSync(engine, bytes, engine._finishFlushFlag);
    return engine._info ? { buffer: out, engine } : out;
}

// what the callback throws is an uncaught exception, as in Node, not a
// rejection
function settle(result: Promise<any>, callback: Function) {
    result
        .then(
            (value) => callback(null, value),
            (error) => callback(error)
        )
        .catch((error) =>
            setTimeout(() => {
                throw error;
            })
        );
}

function zlibBuffer(engine: any, buffer: unknown, callback: Function) {
    validateFunction(callback, "callback");
    let bytes: Uint8Array;
    if (typeof buffer === "string") {
        bytes = Buffer.from(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
        bytes = asBytes(buffer);
    } else if (isAnyArrayBuffer(buffer)) {
        bytes = new Uint8Array(buffer);
    } else {
        throw invalidArgType(
            "chunk",
            "of type string or an instance of Buffer, TypedArray, or DataView",
            buffer
        );
    }
    const handle: ZlibHandle = engine._handle;
    const result = handle
        .oneShot(bytes, oneShotOptions(engine, engine._finishFlushFlag))
        .then(
            (out) => {
                engine.bytesWritten = bytes.byteLength;
                engine.close();
                return engine._info ? { buffer: out, engine } : out;
            },
            (error) => {
                engine[kError] = error;
                engine.close();
                throw error;
            }
        );
    settle(result, callback);
}

function convenienceMethods(ctor: any, name: string) {
    const sync = {
        [name + "Sync"]: (buffer: unknown, opts?: any) =>
            zlibBufferSync(new ctor(opts), buffer)
    }[name + "Sync"];
    const async = {
        [name]: (buffer: unknown, opts: any, callback?: Function) => {
            if (typeof opts === "function") {
                callback = opts;
                opts = {};
            }
            return zlibBuffer(new ctor(opts), buffer, callback!);
        }
    }[name];
    return [async, sync] as [any, any];
}

export const [deflate, deflateSync] = convenienceMethods(Deflate, "deflate");
export const [gzip, gzipSync] = convenienceMethods(Gzip, "gzip");
export const [deflateRaw, deflateRawSync] = convenienceMethods(
    DeflateRaw,
    "deflateRaw"
);
export const [unzip, unzipSync] = convenienceMethods(Unzip, "unzip");
export const [inflate, inflateSync] = convenienceMethods(Inflate, "inflate");
export const [gunzip, gunzipSync] = convenienceMethods(Gunzip, "gunzip");
export const [inflateRaw, inflateRawSync] = convenienceMethods(
    InflateRaw,
    "inflateRaw"
);
export const [brotliCompress, brotliCompressSync] = convenienceMethods(
    BrotliCompress,
    "brotliCompress"
);
export const [brotliDecompress, brotliDecompressSync] = convenienceMethods(
    BrotliDecompress,
    "brotliDecompress"
);

export { constants, crc32 };

const zlib = {
    crc32,
    Deflate,
    Inflate,
    Gzip,
    Gunzip,
    DeflateRaw,
    InflateRaw,
    Unzip,
    BrotliCompress,
    BrotliDecompress,
    deflate,
    deflateSync,
    gzip,
    gzipSync,
    deflateRaw,
    deflateRawSync,
    unzip,
    unzipSync,
    inflate,
    inflateSync,
    gunzip,
    gunzipSync,
    inflateRaw,
    inflateRawSync,
    brotliCompress,
    brotliCompressSync,
    brotliDecompress,
    brotliDecompressSync,
    createDeflate,
    createInflate,
    createDeflateRaw,
    createInflateRaw,
    createGzip,
    createGunzip,
    createUnzip,
    createBrotliCompress,
    createBrotliDecompress,
    constants,
    codes
};

// the zlib constants on the module itself, deprecated and hidden as in Node
for (const [key, value] of Object.entries(constants)) {
    if (key.startsWith("BROTLI")) continue;
    Object.defineProperty(zlib, key, { value, enumerable: false });
}

export default zlib;
