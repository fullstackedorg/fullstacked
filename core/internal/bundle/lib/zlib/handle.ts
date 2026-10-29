// What Node's zlib streams hold as `_handle`: the binding object, here a
// stream of the core's Zlib module, opened at the first write (so that
// creating a stream costs nothing until it is used: ssh2 creates one at
// import to read `_handle.constructor`).
//
// ssh2 (lib/protocol/zlib.js) drives the binding directly for its packet
// compression: `new (createInflate()._handle.constructor)(mode)`, `init(...)`
// with zlib's parameters, `writeSync(flush, in, inOff, inLen, out, outOff,
// outLen)` reading the remaining output and input space from the state array
// given to init(), `onerror(message, errno, code)`, `close()`. That surface
// is served as Node's binding does, over one sync StreamWrite per packet.
// The streams of index.ts use the async methods below.

import { Buffer } from "buffer";
import {
    Compress,
    Decompress,
    Free,
    StreamCreate,
    StreamEnd,
    StreamParams,
    StreamReset,
    StreamWrite
} from "../@types/zlib.ts";
import { call, callAsync, track, untrack } from "./core.ts";
import { constants } from "./constants.ts";

const {
    BROTLI_DECODE,
    BROTLI_ENCODE,
    BROTLI_OPERATION_FINISH,
    DEFLATE,
    DEFLATERAW,
    GUNZIP,
    GZIP,
    INFLATE,
    INFLATERAW,
    UNZIP,
    Z_FINISH
} = constants;

// the core's format of each of Node's modes
const FORMATS: Record<number, [format: string, compress: boolean]> = {
    [DEFLATE]: ["deflate", true],
    [INFLATE]: ["deflate", false],
    [GZIP]: ["gzip", true],
    [GUNZIP]: ["gzip", false],
    [DEFLATERAW]: ["deflateRaw", true],
    [INFLATERAW]: ["deflateRaw", false],
    [UNZIP]: ["unzip", false],
    [BROTLI_ENCODE]: ["brotli", true],
    [BROTLI_DECODE]: ["brotli", false]
};

// the options of the core (core/internal/zlib/options.go)
export type CoreOptions = {
    level?: number;
    windowBits?: number;
    strategy?: number;
    finishFlush?: number;
    maxOutputLength?: number;
    quality?: number;
    lgwin?: number;
};

const EMPTY = new Uint8Array(0);

const toBuffer = (bytes: Uint8Array | undefined | null) =>
    bytes && bytes.byteLength > 0
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Buffer.alloc(0);

export class ZlibHandle {
    // the stream (or ssh2's object) this handle reports errors to
    _owner: any = null;
    onerror: ((message: string, errno: number, code: string) => void) | null =
        null;

    readonly format: string;
    readonly compress: boolean;
    options: CoreOptions = {};
    dictionary: Uint8Array | undefined;

    // the core stream: 0 until the first write, again after its end
    private id = 0;
    private opening: Promise<number> | null = null;
    private closed = false;

    // writeSync: the output not copied to the caller's buffer yet
    private writeState: Uint32Array | null = null;
    private pending: Uint8Array = EMPTY;
    private pendingOffset = 0;
    // the last writeSync filled the caller's buffer: it calls again, with
    // no input, for the rest
    private continuing = false;

    constructor(mode: number) {
        const entry = FORMATS[mode];
        if (!entry) throw new TypeError("Bad argument");
        [this.format, this.compress] = entry;
    }

    // Node's binding init() of the zlib modes
    init(
        windowBits: number,
        level: number,
        _memLevel: number,
        strategy: number,
        writeState: Uint32Array,
        _processCallback?: Function,
        dictionary?: Uint8Array
    ) {
        this.options = { windowBits, level, strategy };
        this.dictionary = dictionary;
        this.writeState = writeState;
        return true;
    }

    private finishes(flush: number) {
        return this.format === "brotli"
            ? flush === BROTLI_OPERATION_FINISH
            : flush === Z_FINISH;
    }

    private createArgs() {
        return [
            this.format,
            this.compress ? "compress" : "decompress",
            this.options,
            this.dictionary
        ] as const;
    }

    private openSync() {
        if (!this.id) {
            this.id = call(StreamCreate, ...this.createArgs());
            track(this, this.id);
        }
        return this.id;
    }

    private async openAsync() {
        if (this.id) return this.id;
        this.opening ??= callAsync(StreamCreate, ...this.createArgs()).then(
            (id: number) => {
                this.opening = null;
                if (this.closed) {
                    callAsync(Free, id).catch(() => {});
                    return 0;
                }
                this.id = id;
                track(this, id);
                return id;
            }
        );
        return this.opening;
    }

    // the stream ended in the core (StreamEnd freed it)
    private ended() {
        untrack(this);
        this.id = 0;
    }

    // One zlib deflate()/inflate() call with all of data, off the JS thread.
    // The finish flush ends the core stream: the write that carries it is
    // the last one that produces output.
    async write(data: Uint8Array, flush: number): Promise<Buffer> {
        if (this.closed) return toBuffer(null);
        const id = await this.openAsync();
        if (!id) return toBuffer(null);
        if (this.finishes(flush) && data.byteLength === 0) {
            this.ended();
            return toBuffer(await callAsync(StreamEnd, id, flush));
        }
        return toBuffer(await callAsync(StreamWrite, id, data, flush));
    }

    // the same, blocking: Node's processChunkSync on a stream in use
    writeAllSync(data: Uint8Array, flush: number): Buffer {
        if (this.closed) return toBuffer(null);
        const id = this.openSync();
        if (this.finishes(flush) && data.byteLength === 0) {
            this.ended();
            return toBuffer(call(StreamEnd, id, flush));
        }
        return toBuffer(call(StreamWrite, id, data, flush));
    }

    // A whole one-shot call (deflateSync() and friends) on a handle that was
    // never written to: one Compress or Decompress call, no core stream
    private oneShotArgs(data: Uint8Array, options: CoreOptions) {
        return [
            this.compress ? Compress : Decompress,
            this.format,
            data,
            { ...this.options, ...options },
            this.dictionary
        ] as const;
    }

    oneShotSync(data: Uint8Array, options: CoreOptions): Buffer {
        const [fn, ...args] = this.oneShotArgs(data, options);
        return toBuffer(call(fn, ...args));
    }

    async oneShot(data: Uint8Array, options: CoreOptions): Promise<Buffer> {
        const [fn, ...args] = this.oneShotArgs(data, options);
        return toBuffer(await callAsync(fn, ...args));
    }

    get opened() {
        return this.id !== 0 || this.opening !== null;
    }

    // Node's binding writeSync, for ssh2: the input is consumed at once,
    // the output handed out as the caller's buffer allows; writeState gets
    // [output space left, input left]. The call that follows a full buffer
    // only hands out the rest: another flush would add an empty block.
    writeSync(
        flush: number,
        input: Uint8Array,
        inOff: number,
        inLen: number,
        out: Uint8Array,
        outOff: number,
        outLen: number
    ) {
        try {
            const hasPending = this.pendingOffset < this.pending.byteLength;
            if (inLen > 0 || (!hasPending && !this.continuing)) {
                const produced = this.writeAllSync(
                    input.subarray(inOff, inOff + inLen),
                    flush
                );
                this.pending = hasPending
                    ? Buffer.concat([
                          this.pending.subarray(this.pendingOffset),
                          produced
                      ])
                    : produced;
                this.pendingOffset = 0;
            }
            const n = Math.min(
                outLen,
                this.pending.byteLength - this.pendingOffset
            );
            out.set(
                this.pending.subarray(
                    this.pendingOffset,
                    this.pendingOffset + n
                ),
                outOff
            );
            this.pendingOffset += n;
            if (this.pendingOffset >= this.pending.byteLength) {
                this.pending = EMPTY;
                this.pendingOffset = 0;
            }
            this.continuing = n === outLen;
            if (this.writeState) {
                this.writeState[0] = outLen - n;
                this.writeState[1] = 0;
            }
        } catch (e: any) {
            if (!this.onerror) throw e;
            this.onerror.call(this, e?.message, e?.errno, e?.code);
        }
    }

    // params() after the stream flushed: what the core still flushes
    paramsSync(level: number, strategy: number): Buffer {
        this.options = { ...this.options, level, strategy };
        if (!this.id) return toBuffer(null);
        return toBuffer(call(StreamParams, this.id, level, strategy));
    }

    reset() {
        this.pending = EMPTY;
        this.pendingOffset = 0;
        if (this.id) call(StreamReset, this.id);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.pending = EMPTY;
        if (this.id) {
            const id = this.id;
            this.ended();
            callAsync(Free, id).catch(() => {});
        }
    }
}
