// stream.Readable (lib/internal/streams/readable.js, Node 24): the same
// state machine, with one plain state object per stream (`_readableState`,
// whose fields npm code reads: `ended`, `endEmitted`, `length`, `flowing`,
// `highWaterMark`...) and every deferral on the microtask queue of ./utils.ts
// instead of process.nextTick.
//
// The per-chunk path is Node's: in flowing mode with an empty buffer, push()
// emits 'data' directly; otherwise the chunk is buffered and flow() reads it
// back on the same turn.

import { Buffer } from "../buffer/index.ts";
import { StringDecoder } from "../string_decoder/index.ts";
import EE from "../events/index.ts";
import { Stream, prependListener } from "./legacy.ts";
import {
    construct,
    destroy,
    destroyer,
    errorOrDestroy,
    undestroy
} from "./destroy.ts";
import { eos } from "./finished.ts";
import { addAbortSignal } from "./addAbortSignal.ts";
import {
    AbortError,
    ERR_INVALID_ARG_TYPE,
    ERR_METHOD_NOT_IMPLEMENTED,
    ERR_OUT_OF_RANGE,
    ERR_STREAM_PUSH_AFTER_EOF,
    ERR_STREAM_UNSHIFT_AFTER_END_EVENT,
    ERR_UNKNOWN_ENCODING,
    aggregateTwoErrors,
    getHighWaterMark,
    getDefaultHighWaterMark,
    nop,
    tick,
    validateObject
} from "./utils.ts";

const isEncoding = (Buffer as any).isEncoding as (e: unknown) => boolean;

// 'data' for a single listener: the call EventEmitter's emit makes, without
// the array its rest parameter allocates per chunk. Not when emit is
// overridden or captureRejections is on.
const emitProto = EE.prototype.emit;
const kCapture = Object.getOwnPropertySymbols(EE.prototype).find(
    (symbol) => symbol.description === "kCapture"
);

function emitData(stream: any, chunk: any) {
    const handler = stream._events?.data;
    if (
        typeof handler === "function" &&
        stream.emit === emitProto &&
        !stream[kCapture]
    ) {
        handler.call(stream, chunk);
    } else {
        stream.emit("data", chunk);
    }
}

export function toBuffer(chunk: ArrayBufferView): Buffer {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export class ReadableState {
    objectMode: boolean;
    highWaterMark: number;
    buffer: any[] = [];
    bufferIndex = 0;
    length = 0;
    pipes: any[] = [];
    flowing: boolean | null = null;
    ended = false;
    endEmitted = false;
    reading = false;
    // false while _construct() runs
    constructed = true;
    // true while _read() runs: what it pushes waits for the next tick
    sync = true;
    needReadable = false;
    emittedReadable = false;
    readableListening = false;
    resumeScheduled = false;
    errorEmitted = false;
    emitClose = true;
    autoDestroy = true;
    destroyed = false;
    closed = false;
    closeEmitted = false;
    errored: any = null;
    defaultEncoding: string = "utf8";
    // null, the dest of a pipe waiting for 'drain', or a Set of them
    awaitDrainWriters: any = null;
    multiAwaitDrain = false;
    readingMore = false;
    dataEmitted = false;
    dataListening = false;
    // pause() (true) or resume() (false) called, null for neither
    paused: boolean | null = null;
    decoder: StringDecoder | null = null;
    encoding: string | null = null;
    readable?: boolean;

    constructor(options?: any, stream?: any, isDuplex?: boolean) {
        this.objectMode = !!(
            options?.objectMode ||
            (isDuplex && options?.readableObjectMode)
        );
        this.highWaterMark = options
            ? getHighWaterMark(
                  this.objectMode,
                  options,
                  "readableHighWaterMark",
                  !!isDuplex
              )
            : getDefaultHighWaterMark(false);
        if (options) {
            if (options.emitClose === false) this.emitClose = false;
            if (options.autoDestroy === false) this.autoDestroy = false;
            const defaultEncoding = options.defaultEncoding;
            if (
                defaultEncoding != null &&
                defaultEncoding !== "utf8" &&
                defaultEncoding !== "utf-8"
            ) {
                if (!isEncoding(defaultEncoding)) {
                    throw ERR_UNKNOWN_ENCODING(defaultEncoding);
                }
                this.defaultEncoding = defaultEncoding;
            }
            if (options.encoding) {
                this.decoder = new StringDecoder(options.encoding);
                this.encoding = options.encoding;
            }
        }
    }

    get pipesCount() {
        return this.pipes.length;
    }
}

export function Readable(this: any, options?: any): any {
    if (!(this instanceof (Readable as any)))
        return new (Readable as any)(options);
    this._readableState = new ReadableState(options, this, false);
    if (options) {
        if (typeof options.read === "function") this._read = options.read;
        if (typeof options.destroy === "function") {
            this._destroy = options.destroy;
        }
        if (typeof options.construct === "function") {
            this._construct = options.construct;
        }
        if (options.signal) addAbortSignal(options.signal, this);
    }
    (Stream as any).call(this, options);
    if (this._construct != null) {
        construct(this, () => onConstructed(this));
    }
}

export function onConstructed(stream: any) {
    const state = stream._readableState;
    if (state.needReadable) maybeReadMore(stream, state);
}
Readable.ReadableState = ReadableState;
Object.setPrototypeOf(Readable.prototype, Stream.prototype);
Object.setPrototypeOf(Readable, Stream);

const proto = Readable.prototype;

proto.destroy = destroy;
proto._undestroy = undestroy;
proto._destroy = function (err: any, cb: (err?: any) => void) {
    cb(err);
};
proto[(EE as any).captureRejectionSymbol] = function (this: any, err: any) {
    this.destroy(err);
};
const asyncDispose: symbol = (Symbol as any).asyncDispose;
if (asyncDispose) {
    proto[asyncDispose] = async function (this: any) {
        let error: any;
        if (!this.destroyed) {
            error = this.readableEnded ? null : new AbortError();
            this.destroy(error);
        }
        await new Promise((resolve, reject) =>
            eos(this, (err) =>
                err && err !== error ? reject(err) : resolve(null)
            )
        );
    };
}

proto.push = function (this: any, chunk: any, encoding?: string) {
    const state = this._readableState;
    return state.objectMode
        ? pushObjectMode(this, state, chunk, encoding)
        : pushByteMode(this, state, chunk, encoding);
};

proto.unshift = function (this: any, chunk: any, encoding?: string) {
    const state = this._readableState;
    return state.objectMode
        ? unshiftObjectMode(this, state, chunk)
        : unshiftByteMode(this, state, chunk, encoding);
};

function invalidChunk(stream: any, chunk: any) {
    errorOrDestroy(
        stream,
        ERR_INVALID_ARG_TYPE(
            "chunk",
            ["string", "Buffer", "TypedArray", "DataView"],
            chunk
        )
    );
    return false;
}

function unshiftByteMode(
    stream: any,
    state: ReadableState,
    chunk: any,
    encoding?: string
) {
    if (chunk === null) {
        state.reading = false;
        onEofChunk(stream, state);
        return false;
    }
    if (typeof chunk === "string") {
        encoding ||= state.defaultEncoding;
        if (state.encoding !== encoding) {
            chunk = state.encoding
                ? Buffer.from(chunk, encoding as BufferEncoding).toString(
                      state.encoding as BufferEncoding
                  )
                : Buffer.from(chunk, encoding as BufferEncoding);
        }
    } else if (ArrayBuffer.isView(chunk)) {
        if (!(chunk instanceof Buffer)) chunk = toBuffer(chunk);
    } else if (chunk !== undefined) {
        return invalidChunk(stream, chunk);
    }
    if (!(chunk && chunk.length > 0)) return canPushMore(state);
    return unshiftValue(stream, state, chunk);
}

function unshiftObjectMode(stream: any, state: ReadableState, chunk: any) {
    if (chunk === null) {
        state.reading = false;
        onEofChunk(stream, state);
        return false;
    }
    return unshiftValue(stream, state, chunk);
}

function unshiftValue(stream: any, state: ReadableState, chunk: any) {
    if (state.endEmitted) {
        errorOrDestroy(stream, ERR_STREAM_UNSHIFT_AFTER_END_EVENT());
    } else if (state.destroyed || state.errored) {
        return false;
    } else {
        addChunk(stream, state, chunk, true);
    }
    return canPushMore(state);
}

function pushByteMode(
    stream: any,
    state: ReadableState,
    chunk: any,
    encoding?: string
) {
    if (chunk === null) {
        state.reading = false;
        onEofChunk(stream, state);
        return false;
    }
    if (typeof chunk === "string") {
        encoding ||= state.defaultEncoding;
        if (state.encoding !== encoding) {
            chunk = Buffer.from(chunk, encoding as BufferEncoding);
            encoding = "";
        }
    } else if (chunk instanceof Buffer) {
        encoding = "";
    } else if (ArrayBuffer.isView(chunk)) {
        chunk = toBuffer(chunk);
        encoding = "";
    } else if (chunk !== undefined) {
        return invalidChunk(stream, chunk);
    }

    if (!chunk || chunk.length <= 0) {
        state.reading = false;
        maybeReadMore(stream, state);
        return canPushMore(state);
    }
    if (state.ended) {
        errorOrDestroy(stream, ERR_STREAM_PUSH_AFTER_EOF());
        return false;
    }
    if (state.destroyed || state.errored) return false;

    state.reading = false;
    if (state.decoder !== null && !encoding) {
        chunk = state.decoder.write(chunk);
        if (chunk.length === 0) {
            maybeReadMore(stream, state);
            return canPushMore(state);
        }
    }
    addChunk(stream, state, chunk, false);
    return canPushMore(state);
}

function pushObjectMode(
    stream: any,
    state: ReadableState,
    chunk: any,
    encoding?: string
) {
    if (chunk === null) {
        state.reading = false;
        onEofChunk(stream, state);
        return false;
    }
    if (state.ended) {
        errorOrDestroy(stream, ERR_STREAM_PUSH_AFTER_EOF());
        return false;
    }
    if (state.destroyed || state.errored) return false;
    state.reading = false;
    if (state.decoder !== null && !encoding) {
        chunk = state.decoder.write(chunk);
    }
    addChunk(stream, state, chunk, false);
    return canPushMore(state);
}

function canPushMore(state: ReadableState) {
    // below the highWaterMark, or nothing buffered (highWaterMark 0)
    return (
        !state.ended &&
        (state.length < state.highWaterMark || state.length === 0)
    );
}

function addChunk(
    stream: any,
    state: ReadableState,
    chunk: any,
    addToFront: boolean
) {
    if (
        state.flowing === true &&
        !state.sync &&
        state.dataListening &&
        state.length === 0
    ) {
        // the fast path: straight to the 'data' listeners
        if (state.multiAwaitDrain) state.awaitDrainWriters.clear();
        else state.awaitDrainWriters = null;
        state.dataEmitted = true;
        emitData(stream, chunk);
    } else {
        state.length += state.objectMode ? 1 : chunk.length;
        if (addToFront) {
            if (state.bufferIndex > 0)
                state.buffer[--state.bufferIndex] = chunk;
            else state.buffer.unshift(chunk);
        } else {
            state.buffer.push(chunk);
        }
        if (state.needReadable) emitReadable(stream);
    }
    maybeReadMore(stream, state);
}

proto.isPaused = function (this: any) {
    const state = this._readableState;
    return state.paused === true || state.flowing === false;
};

proto.setEncoding = function (this: any, enc?: string) {
    const state = this._readableState;
    const decoder = new StringDecoder(enc);
    state.decoder = decoder;
    // setEncoding(null) is utf8
    state.encoding = decoder.encoding;
    // the chunks already buffered are decoded
    let content = "";
    for (let i = state.bufferIndex; i < state.buffer.length; i++) {
        content += decoder.write(state.buffer[i]);
    }
    state.buffer.length = 0;
    state.bufferIndex = 0;
    if (content !== "") state.buffer.push(content);
    state.length = content.length;
    return this;
};

// up to 1 GiB, the next power of 2
const MAX_HWM = 0x40000000;
function computeNewHighWaterMark(n: number) {
    if (n > MAX_HWM) throw ERR_OUT_OF_RANGE("size", "<= 1GiB", n);
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    return n + 1;
}

function howMuchToRead(n: number, state: ReadableState) {
    if (n <= 0 || (state.length === 0 && state.ended)) return 0;
    if (state.objectMode) return 1;
    if (n !== n) {
        // NaN: one chunk at a time when flowing, else everything
        if (state.flowing === true && state.length) {
            return state.buffer[state.bufferIndex].length;
        }
        return state.length;
    }
    if (n <= state.length) return n;
    return state.ended ? state.length : 0;
}

proto.read = function (this: any, n?: number) {
    if (n === undefined) n = NaN;
    else if (!Number.isInteger(n)) n = parseInt(n as any, 10);
    const state: ReadableState = this._readableState;
    const nOrig = n;

    if (n > state.highWaterMark) {
        state.highWaterMark = computeNewHighWaterMark(n);
    }
    if (n !== 0) state.emittedReadable = false;

    // read(0) with enough buffered (or the end) only emits 'readable'
    if (
        n === 0 &&
        state.needReadable &&
        ((state.highWaterMark !== 0
            ? state.length >= state.highWaterMark
            : state.length > 0) ||
            state.ended)
    ) {
        if (state.length === 0 && state.ended) endReadable(this);
        else emitReadable(this);
        return null;
    }

    n = howMuchToRead(n, state);

    if (n === 0 && state.ended) {
        if (state.length === 0) endReadable(this);
        return null;
    }

    // _read() first, if the buffer is to go below the highWaterMark: a
    // synchronous _read() changes what there is to return
    let doRead = state.needReadable;
    if (state.length === 0 || state.length - n < state.highWaterMark) {
        doRead = true;
    }
    if (
        state.reading ||
        state.ended ||
        state.destroyed ||
        state.errored ||
        !state.constructed
    ) {
        doRead = false;
    } else if (doRead) {
        state.reading = true;
        state.sync = true;
        if (state.length === 0) state.needReadable = true;
        try {
            this._read(state.highWaterMark);
        } catch (err) {
            errorOrDestroy(this, err);
        }
        state.sync = false;
        if (!state.reading) n = howMuchToRead(nOrig, state);
    }

    let ret = n > 0 ? fromList(n, state) : null;

    if (ret === null) {
        if (state.length <= state.highWaterMark) state.needReadable = true;
        n = 0;
    } else {
        state.length -= n;
        if (state.multiAwaitDrain) state.awaitDrainWriters.clear();
        else state.awaitDrainWriters = null;
    }

    if (state.length === 0) {
        // nothing buffered: tell us as soon as there is
        if (!state.ended) state.needReadable = true;
        // read() past the end
        if (nOrig !== n && state.ended) endReadable(this);
    }

    if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
        state.dataEmitted = true;
        emitData(this, ret);
    }
    return ret;
};

function onEofChunk(stream: any, state: ReadableState) {
    if (state.ended) return;
    const decoder = state.decoder;
    if (decoder) {
        const chunk = decoder.end();
        if (chunk?.length) {
            state.buffer.push(chunk);
            state.length += state.objectMode ? 1 : chunk.length;
        }
    }
    state.ended = true;
    if (state.sync) {
        // the data waits for the next tick: not in the middle of a read()
        emitReadable(stream);
    } else {
        // now, synchronously (dicer and others rely on it)
        state.needReadable = false;
        state.emittedReadable = true;
        emitReadable_(stream);
    }
}

function emitReadable(stream: any) {
    const state = stream._readableState;
    state.needReadable = false;
    if (!state.emittedReadable) {
        state.emittedReadable = true;
        tick(emitReadable_, stream);
    }
}

function emitReadable_(stream: any) {
    const state: ReadableState = stream._readableState;
    if (!state.destroyed && !state.errored && (state.length || state.ended)) {
        stream.emit("readable");
        state.emittedReadable = false;
    }
    // another 'readable' is needed if not flowing, not ended and below the
    // highWaterMark
    if (
        state.flowing !== true &&
        !state.ended &&
        state.length <= state.highWaterMark
    ) {
        state.needReadable = true;
    }
    flow(stream);
}

// read ahead up to the highWaterMark, on the next tick
function maybeReadMore(stream: any, state: ReadableState) {
    if (!state.readingMore && !state.reading && state.constructed) {
        state.readingMore = true;
        tick(maybeReadMore_, stream, state);
    }
}

function maybeReadMore_(stream: any, state: ReadableState) {
    while (
        !state.reading &&
        !state.ended &&
        (state.length < state.highWaterMark ||
            (state.flowing === true && state.length === 0))
    ) {
        const len = state.length;
        stream.read(0);
        // no data: stop spinning
        if (len === state.length) break;
    }
    state.readingMore = false;
}

proto._read = function (_n: number) {
    throw ERR_METHOD_NOT_IMPLEMENTED("_read()");
};

proto.pipe = function (this: any, dest: any, pipeOpts?: any) {
    const src = this;
    const state: ReadableState = this._readableState;

    if (state.pipes.length === 1 && !state.multiAwaitDrain) {
        state.multiAwaitDrain = true;
        state.awaitDrainWriters = new Set(
            state.awaitDrainWriters ? [state.awaitDrainWriters] : []
        );
    }
    state.pipes.push(dest);

    const process = (globalThis as any).process;
    const doEnd =
        (!pipeOpts || pipeOpts.end !== false) &&
        (!process || (dest !== process.stdout && dest !== process.stderr));

    const endFn = doEnd ? onend : unpipe;
    if (state.endEmitted) tick(endFn);
    else src.once("end", endFn);

    dest.on("unpipe", onunpipe);
    function onunpipe(readable: any, unpipeInfo: any) {
        if (readable === src && unpipeInfo && unpipeInfo.hasUnpiped === false) {
            unpipeInfo.hasUnpiped = true;
            cleanup();
        }
    }

    function onend() {
        dest.end();
    }

    let ondrain: (() => void) | undefined;
    let cleanedUp = false;
    function cleanup() {
        dest.removeListener("close", onclose);
        dest.removeListener("finish", onfinish);
        if (ondrain) dest.removeListener("drain", ondrain);
        dest.removeListener("error", onerror);
        dest.removeListener("unpipe", onunpipe);
        src.removeListener("end", onend);
        src.removeListener("end", unpipe);
        src.removeListener("data", ondata);
        cleanedUp = true;
        // a source waiting for this dest's 'drain' would wait forever
        if (
            ondrain &&
            state.awaitDrainWriters &&
            (!dest._writableState || dest._writableState.needDrain)
        ) {
            ondrain();
        }
    }

    function pause() {
        // unpiped during dest.write(): not paused for good
        if (!cleanedUp) {
            if (state.pipes.length === 1 && state.pipes[0] === dest) {
                state.awaitDrainWriters = dest;
                state.multiAwaitDrain = false;
            } else if (state.pipes.length > 1 && state.pipes.includes(dest)) {
                state.awaitDrainWriters.add(dest);
            }
            src.pause();
        }
        if (!ondrain) {
            ondrain = pipeOnDrain(src, dest);
            dest.on("drain", ondrain);
        }
    }

    src.on("data", ondata);
    function ondata(chunk: any) {
        try {
            if (dest.write(chunk) === false) pause();
        } catch (error) {
            dest.destroy(error);
        }
    }

    // stop piping on a dest error, which still throws without a listener
    function onerror(er: any) {
        unpipe();
        dest.removeListener("error", onerror);
        if (dest.listenerCount("error") === 0) {
            const s = dest._writableState || dest._readableState;
            if (s && !s.errorEmitted) errorOrDestroy(dest, er);
            else dest.emit("error", er);
        }
    }
    prependListener(dest, "error", onerror);

    function onclose() {
        dest.removeListener("finish", onfinish);
        unpipe();
    }
    dest.once("close", onclose);
    function onfinish() {
        dest.removeListener("close", onclose);
        unpipe();
    }
    dest.once("finish", onfinish);

    function unpipe() {
        src.unpipe(dest);
    }

    dest.emit("pipe", src);

    if (dest.writableNeedDrain === true) pause();
    else if (state.flowing !== true) src.resume();

    return dest;
};

function pipeOnDrain(src: any, dest: any) {
    return function pipeOnDrainFunctionResult() {
        const state: ReadableState = src._readableState;
        if (state.awaitDrainWriters === dest) {
            state.awaitDrainWriters = null;
        } else if (state.multiAwaitDrain) {
            state.awaitDrainWriters.delete(dest);
        }
        if (
            (!state.awaitDrainWriters || state.awaitDrainWriters.size === 0) &&
            state.dataListening
        ) {
            src.resume();
        }
    };
}

proto.unpipe = function (this: any, dest?: any) {
    const state: ReadableState = this._readableState;
    if (state.pipes.length === 0) return this;
    if (!dest) {
        const dests = state.pipes;
        state.pipes = [];
        this.pause();
        for (let i = 0; i < dests.length; i++) {
            dests[i].emit("unpipe", this, { hasUnpiped: false });
        }
        return this;
    }
    const index = state.pipes.indexOf(dest);
    if (index === -1) return this;
    state.pipes.splice(index, 1);
    if (state.pipes.length === 0) this.pause();
    dest.emit("unpipe", this, { hasUnpiped: false });
    return this;
};

const on = EE.prototype.on;
const removeListener = EE.prototype.removeListener;
const removeAllListeners = EE.prototype.removeAllListeners;

// 'data' starts the flow, 'readable' switches to paused mode
proto.on = function (
    this: any,
    ev: string | symbol,
    fn: (...args: any[]) => void
) {
    const res = on.call(this, ev, fn);
    const state: ReadableState = this._readableState;
    if (ev === "data") {
        state.dataListening = true;
        // so that resume() is a no-op below for once('readable')
        if (this.listenerCount("readable") > 0) state.readableListening = true;
        // flowing on the next tick unless paused explicitly
        if (state.flowing !== false) this.resume();
    } else if (ev === "readable") {
        if (!state.endEmitted && !state.readableListening) {
            state.readableListening = state.needReadable = true;
            state.flowing = false;
            state.emittedReadable = false;
            if (state.length) emitReadable(this);
            else if (!state.reading) tick(nReadingNextTick, this);
        }
    }
    return res;
};
proto.addListener = proto.on;

proto.removeListener = function (
    this: any,
    ev: string | symbol,
    fn: (...args: any[]) => void
) {
    const state: ReadableState = this._readableState;
    const res = removeListener.call(this, ev, fn);
    if (ev === "readable") {
        // after 'readable' is emitted, before I/O: once('readable') cycles
        tick(updateReadableListening, this);
    } else if (ev === "data" && this.listenerCount("data") === 0) {
        state.dataListening = false;
    }
    return res;
};
proto.off = proto.removeListener;

proto.removeAllListeners = function (this: any, ev?: string | symbol) {
    const res = removeAllListeners.apply(this, arguments as any);
    if (ev === "readable" || ev === undefined) {
        tick(updateReadableListening, this);
    }
    return res;
};

function updateReadableListening(self: any) {
    const state: ReadableState = self._readableState;
    state.readableListening = self.listenerCount("readable") > 0;
    if (state.resumeScheduled && state.paused === false) {
        // the resume() to come has to flow
        state.flowing = true;
    } else if (state.dataListening) {
        self.resume();
    } else if (!state.readableListening) {
        state.flowing = null;
    }
}

function nReadingNextTick(self: any) {
    self.read(0);
}

proto.resume = function (this: any) {
    const state: ReadableState = this._readableState;
    if (state.destroyed) return this;
    if (state.flowing !== true) {
        // flowing only without 'readable' listeners
        state.flowing = !state.readableListening;
        resume(this, state);
    }
    state.paused = false;
    return this;
};

function resume(stream: any, state: ReadableState) {
    if (!state.resumeScheduled) {
        state.resumeScheduled = true;
        tick(resume_, stream, state);
    }
}

function resume_(stream: any, state: ReadableState) {
    if (!state.reading) stream.read(0);
    state.resumeScheduled = false;
    stream.emit("resume");
    flow(stream);
    if (state.flowing === true && !state.reading) stream.read(0);
}

proto.pause = function (this: any) {
    const state: ReadableState = this._readableState;
    if (state.destroyed) return this;
    if (state.flowing !== false) {
        state.flowing = false;
        this.emit("pause");
    }
    state.paused = true;
    return this;
};

function flow(stream: any) {
    const state: ReadableState = stream._readableState;
    while (state.flowing === true && stream.read() !== null);
}

// an old-style stream (data/end events) as the source
proto.wrap = function (this: any, stream: any) {
    let paused = false;
    stream.on("data", (chunk: any) => {
        if (!this.push(chunk) && stream.pause) {
            paused = true;
            stream.pause();
        }
    });
    stream.on("end", () => this.push(null));
    stream.on("error", (err: any) => errorOrDestroy(this, err));
    stream.on("close", () => this.destroy());
    stream.on("destroy", () => this.destroy());
    this._read = () => {
        if (paused && stream.resume) {
            paused = false;
            stream.resume();
        }
    };
    // the other methods, for filters and duplexes
    const keys = Object.keys(stream);
    for (let j = 1; j < keys.length; j++) {
        const i = keys[j];
        if (this[i] === undefined && typeof stream[i] === "function") {
            this[i] = stream[i].bind(stream);
        }
    }
    return this;
};

proto[Symbol.asyncIterator] = function (this: any) {
    return streamToAsyncIterator(this);
};

proto.iterator = function (this: any, options?: any) {
    if (options !== undefined) validateObject(options, "options");
    return streamToAsyncIterator(this, options);
};

function streamToAsyncIterator(stream: any, options?: any) {
    if (typeof stream.read !== "function") {
        stream = (Readable as any).wrap(stream, { objectMode: true });
    }
    const iter: any = createAsyncIterator(stream, options);
    iter.stream = stream;
    return iter;
}

async function* createAsyncIterator(stream: any, options?: any) {
    let callback: () => void = nop;
    function next(this: any, resolve: () => void) {
        if (this === stream) {
            callback();
            callback = nop;
        } else {
            callback = resolve;
        }
    }
    stream.on("readable", next);

    let error: any;
    const cleanup = eos(stream, { writable: false }, (err) => {
        error = err ? aggregateTwoErrors(error, err) : null;
        callback();
        callback = nop;
    });

    try {
        while (true) {
            const chunk = stream.destroyed ? null : stream.read();
            if (chunk !== null) yield chunk;
            else if (error) throw error;
            else if (error === null) return;
            else await new Promise(next as any);
        }
    } catch (err) {
        error = aggregateTwoErrors(error, err);
        throw error;
    } finally {
        if (
            (error || options?.destroyOnReturn !== false) &&
            (error === undefined || stream._readableState.autoDestroy)
        ) {
            destroyer(stream, null);
        } else {
            stream.off("readable", next);
            cleanup();
        }
    }
}

function getter(
    name: string,
    get: (state: any) => any,
    set?: (state: any, value: any) => void
) {
    Object.defineProperty(proto, name, {
        get(this: any) {
            return get(this._readableState);
        },
        set: set
            ? function (this: any, value: any) {
                  if (this._readableState) set(this._readableState, value);
              }
            : undefined,
        configurable: true
    });
}

// readable: false for the disabled side of a Duplex too
getter(
    "readable",
    (r) =>
        !!r &&
        r.readable !== false &&
        !r.destroyed &&
        !r.errorEmitted &&
        !r.endEmitted,
    (r, value) => (r.readable = !!value)
);
getter("readableDidRead", (r) => r.dataEmitted);
getter(
    "readableAborted",
    (r) =>
        !!(r.readable !== false && (r.destroyed || r.errored) && !r.endEmitted)
);
getter("readableHighWaterMark", (r) => r.highWaterMark);
getter("readableBuffer", (r) => r?.buffer);
getter(
    "readableFlowing",
    (r) => r.flowing,
    (r, value) => (r.flowing = value)
);
getter("readableLength", (r) => r.length);
getter("readableObjectMode", (r) => (r ? r.objectMode : false));
getter("readableEncoding", (r) => (r ? r.encoding : null));
getter("errored", (r) => (r ? r.errored : null));
getter("closed", (r) => (r ? r.closed : false));
getter(
    "destroyed",
    (r) => (r ? r.destroyed : false),
    (r, value) => (r.destroyed = value)
);
getter("readableEnded", (r) => (r ? r.endEmitted : false));

// pluck n bytes (or one object) off the buffer
function fromList(n: number, state: ReadableState) {
    if (state.length === 0) return null;

    let idx = state.bufferIndex;
    let ret: any;
    const buf = state.buffer;
    const len = buf.length;

    if (state.objectMode) {
        ret = buf[idx];
        buf[idx++] = null;
    } else if (!n || n >= state.length) {
        // all of it
        if (state.decoder !== null) {
            ret = "";
            while (idx < len) {
                ret += buf[idx];
                buf[idx++] = null;
            }
        } else if (len - idx === 0) {
            ret = Buffer.alloc(0);
        } else if (len - idx === 1) {
            ret = buf[idx];
            buf[idx++] = null;
        } else {
            ret = Buffer.allocUnsafe(state.length);
            let i = 0;
            while (idx < len) {
                ret.set(buf[idx], i);
                i += buf[idx].length;
                buf[idx++] = null;
            }
        }
    } else if (n < buf[idx].length) {
        // slice is the same for buffers and strings
        ret = buf[idx].slice(0, n);
        buf[idx] = buf[idx].slice(n);
    } else if (n === buf[idx].length) {
        ret = buf[idx];
        buf[idx++] = null;
    } else if (state.decoder !== null) {
        ret = "";
        while (idx < len) {
            const str = buf[idx];
            if (n > str.length) {
                ret += str;
                n -= str.length;
                buf[idx++] = null;
            } else {
                if (n === str.length) {
                    ret += str;
                    buf[idx++] = null;
                } else {
                    ret += str.slice(0, n);
                    buf[idx] = str.slice(n);
                }
                break;
            }
        }
    } else {
        ret = Buffer.allocUnsafe(n);
        const retLen = n;
        while (idx < len) {
            const data = buf[idx];
            if (n > data.length) {
                ret.set(data, retLen - n);
                n -= data.length;
                buf[idx++] = null;
            } else {
                if (n === data.length) {
                    ret.set(data, retLen - n);
                    buf[idx++] = null;
                } else {
                    ret.set(data.subarray(0, n), retLen - n);
                    buf[idx] = data.subarray(n);
                }
                break;
            }
        }
    }

    if (idx === len) {
        state.buffer.length = 0;
        state.bufferIndex = 0;
    } else if (idx > 1024) {
        state.buffer.splice(0, idx);
        state.bufferIndex = 0;
    } else {
        state.bufferIndex = idx;
    }
    return ret;
}
(Readable as any)._fromList = fromList;

function endReadable(stream: any) {
    const state: ReadableState = stream._readableState;
    if (!state.endEmitted) {
        state.ended = true;
        tick(endReadableNT, state, stream);
    }
}

function endReadableNT(state: ReadableState, stream: any) {
    // not if one last unshift() came in
    if (
        !state.errored &&
        !state.closeEmitted &&
        !state.endEmitted &&
        state.length === 0
    ) {
        state.endEmitted = true;
        stream.emit("end");
        if (stream.writable && stream.allowHalfOpen === false) {
            tick(endWritableNT, stream);
        } else if (state.autoDestroy) {
            // a Duplex waits for its writable side too
            const w = stream._writableState;
            if (!w || (w.autoDestroy && (w.finished || w.writable === false))) {
                stream.destroy();
            }
        }
    }
}

function endWritableNT(stream: any) {
    if (stream.writable && !stream.writableEnded && !stream.destroyed) {
        stream.end();
    }
}

(Readable as any).wrap = function (src: any, options?: any) {
    return new (Readable as any)({
        objectMode: src.readableObjectMode ?? src.objectMode ?? true,
        ...options,
        destroy(err: any, callback: (err?: any) => void) {
            destroyer(src, err);
            callback(err);
        }
    }).wrap(src);
};
