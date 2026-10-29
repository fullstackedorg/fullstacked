// stream.Writable (lib/internal/streams/writable.js, Node 24): one plain
// state object per stream (`_writableState`: `ending`, `ended`, `finished`,
// `needDrain`, `length`, `finalCalled`...), deferrals on the microtask queue
// of ./utils.ts.
//
// The per-chunk path allocates nothing: `onwrite` is bound once per stream,
// and the write callbacks that complete synchronously are counted, not
// queued, as Node does.

import { Buffer } from "../buffer/index.ts";
import EE from "../events/index.ts";
import { Stream } from "./legacy.ts";
import { construct, destroy, errorOrDestroy, undestroy } from "./destroy.ts";
import { eos } from "./finished.ts";
import { addAbortSignal } from "./addAbortSignal.ts";
import { toBuffer } from "./readable.ts";
import {
    AbortError,
    ERR_INVALID_ARG_TYPE,
    ERR_METHOD_NOT_IMPLEMENTED,
    ERR_MULTIPLE_CALLBACK,
    ERR_STREAM_ALREADY_FINISHED,
    ERR_STREAM_CANNOT_PIPE,
    ERR_STREAM_DESTROYED,
    ERR_STREAM_NULL_VALUES,
    ERR_STREAM_WRITE_AFTER_END,
    ERR_UNKNOWN_ENCODING,
    getDefaultHighWaterMark,
    getHighWaterMark,
    nop,
    tick
} from "./utils.ts";

const isEncoding = (Buffer as any).isEncoding as (e: unknown) => boolean;

type WriteCallback = (err?: any) => void;
type Entry = { chunk: any; encoding: string; callback: WriteCallback };
type TickInfo = {
    count: number;
    cb: WriteCallback;
    stream: any;
    state: WritableState;
};

export class WritableState {
    objectMode: boolean;
    highWaterMark: number;
    finalCalled = false;
    needDrain = false;
    // end() called / returned
    ending = false;
    ended = false;
    // 'finish' emitted
    finished = false;
    destroyed = false;
    decodeStrings: boolean;
    defaultEncoding: string = "utf8";
    // bytes (or objects) written and not yet called back
    length = 0;
    writing = false;
    corked = 0;
    // true while _write() runs
    sync = true;
    bufferProcessing = false;
    // the callback given to _write(), bound once
    onwrite: (er?: any) => void;
    writecb: WriteCallback | null = null;
    writelen = 0;
    afterWriteTickInfo: TickInfo | null = null;
    buffered: Entry[] = [];
    bufferedIndex = 0;
    allBuffers = true;
    allNoop = true;
    // write callbacks pending: 'finish' waits for 0
    pendingcb = 0;
    constructed = true;
    prefinished = false;
    errorEmitted = false;
    emitClose = true;
    autoDestroy = true;
    errored: any = null;
    closed = false;
    closeEmitted = false;
    expectWriteCb = false;
    afterWritePending = false;
    onFinished: WriteCallback[] | null = null;
    writable?: boolean;

    constructor(options?: any, stream?: any, isDuplex?: boolean) {
        this.objectMode = !!(
            options?.objectMode ||
            (isDuplex && options?.writableObjectMode)
        );
        this.highWaterMark = options
            ? getHighWaterMark(
                  this.objectMode,
                  options,
                  "writableHighWaterMark",
                  !!isDuplex
              )
            : getDefaultHighWaterMark(false);
        this.decodeStrings = !options || options.decodeStrings !== false;
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
        }
        this.onwrite = (er?: any) => onwrite(stream, er);
    }

    getBuffer() {
        return this.buffered.slice(this.bufferedIndex);
    }

    get bufferedRequestCount() {
        return this.buffered.length - this.bufferedIndex;
    }
}

function resetBuffer(state: WritableState) {
    state.buffered = [];
    state.bufferedIndex = 0;
    state.allBuffers = true;
    state.allNoop = true;
}

export function onConstructed(stream: any) {
    const state: WritableState = stream._writableState;
    if (!state.writing) clearBuffer(stream, state);
    if (state.ending) finishMaybe(stream, state);
}

export function Writable(this: any, options?: any): any {
    if (!(this instanceof (Writable as any)))
        return new (Writable as any)(options);
    this._writableState = new WritableState(options, this, false);
    if (options) {
        if (typeof options.write === "function") this._write = options.write;
        if (typeof options.writev === "function") this._writev = options.writev;
        if (typeof options.destroy === "function") {
            this._destroy = options.destroy;
        }
        if (typeof options.final === "function") this._final = options.final;
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
Writable.WritableState = WritableState;
Object.setPrototypeOf(Writable.prototype, Stream.prototype);
Object.setPrototypeOf(Writable, Stream);

// a Duplex is a Writable too
Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (this: any, object: any) {
        if (Function.prototype[Symbol.hasInstance].call(this, object)) {
            return true;
        }
        if (this !== Writable) return false;
        return !!object && object._writableState instanceof WritableState;
    }
});

const proto = Writable.prototype;

proto.pipe = function (this: any) {
    errorOrDestroy(this, ERR_STREAM_CANNOT_PIPE());
};

function _write(stream: any, chunk: any, encoding: any, cb?: WriteCallback) {
    const state: WritableState = stream._writableState;
    if (typeof cb !== "function") cb = nop;
    if (chunk === null) throw ERR_STREAM_NULL_VALUES();

    if (!state.objectMode) {
        if (!encoding) {
            encoding = state.defaultEncoding;
        } else if (encoding !== "buffer" && !isEncoding(encoding)) {
            throw ERR_UNKNOWN_ENCODING(encoding);
        }
        if (typeof chunk === "string") {
            if (state.decodeStrings) {
                chunk = Buffer.from(chunk, encoding);
                encoding = "buffer";
            }
        } else if (chunk instanceof Buffer) {
            encoding = "buffer";
        } else if (ArrayBuffer.isView(chunk)) {
            chunk = toBuffer(chunk);
            encoding = "buffer";
        } else {
            throw ERR_INVALID_ARG_TYPE(
                "chunk",
                ["string", "Buffer", "TypedArray", "DataView"],
                chunk
            );
        }
    }

    let err: any;
    if (state.ending) err = ERR_STREAM_WRITE_AFTER_END();
    else if (state.destroyed) err = ERR_STREAM_DESTROYED("write");
    if (err) {
        tick(cb, err);
        errorOrDestroy(stream, err, true);
        return err;
    }
    state.pendingcb++;
    return writeOrBuffer(stream, state, chunk, encoding, cb);
}

proto.write = function (
    this: any,
    chunk: any,
    encoding?: any,
    cb?: WriteCallback
) {
    if (typeof encoding === "function") {
        cb = encoding;
        encoding = null;
    }
    return _write(this, chunk, encoding, cb) === true;
};

proto.cork = function (this: any) {
    this._writableState.corked++;
};

proto.uncork = function (this: any) {
    const state: WritableState = this._writableState;
    if (state.corked) {
        state.corked--;
        if (!state.writing) clearBuffer(this, state);
    }
};

proto.setDefaultEncoding = function (this: any, encoding: any) {
    if (typeof encoding === "string") encoding = encoding.toLowerCase();
    if (!isEncoding(encoding)) throw ERR_UNKNOWN_ENCODING(encoding);
    this._writableState.defaultEncoding = encoding;
    return this;
};

// _write() now, or into the buffer behind the write in progress
function writeOrBuffer(
    stream: any,
    state: WritableState,
    chunk: any,
    encoding: string,
    callback: WriteCallback
) {
    const len = state.objectMode ? 1 : chunk.length;
    state.length += len;

    if (state.writing || state.errored || state.corked || !state.constructed) {
        state.buffered.push({ chunk, encoding, callback });
        if (encoding !== "buffer") state.allBuffers = false;
        if (callback !== nop) state.allNoop = false;
    } else {
        state.writelen = len;
        if (callback !== nop) state.writecb = callback;
        state.writing = state.sync = state.expectWriteCb = true;
        stream._write(chunk, encoding, state.onwrite);
        state.sync = false;
    }

    const ret = state.length < state.highWaterMark || state.length === 0;
    if (!ret) state.needDrain = true;
    // false when errored or destroyed: ends while (write()) loops
    return ret && !state.destroyed && !state.errored;
}

function doWrite(
    stream: any,
    state: WritableState,
    writev: boolean,
    len: number,
    chunk: any,
    encoding: string,
    cb: WriteCallback
) {
    state.writelen = len;
    if (cb !== nop) state.writecb = cb;
    state.writing = state.sync = state.expectWriteCb = true;
    if (state.destroyed) state.onwrite(ERR_STREAM_DESTROYED("write"));
    else if (writev) stream._writev(chunk, state.onwrite);
    else stream._write(chunk, encoding, state.onwrite);
    state.sync = false;
}

function onwriteError(
    stream: any,
    state: WritableState,
    er: any,
    cb: WriteCallback
) {
    --state.pendingcb;
    cb(er);
    // the buffered writes are called back too, even without autoDestroy
    errorBuffer(state);
    // 'error' after the callback
    errorOrDestroy(stream, er);
}

function onwrite(stream: any, er?: any) {
    const state: WritableState = stream._writableState;
    if (!state.expectWriteCb) {
        errorOrDestroy(stream, ERR_MULTIPLE_CALLBACK());
        return;
    }
    const sync = state.sync;
    const cb = state.writecb || nop;
    state.writecb = null;
    state.writing = state.expectWriteCb = false;
    state.length -= state.writelen;
    state.writelen = 0;

    if (er) {
        if (!state.errored) state.errored = er;
        // the readable side of a Duplex errors too
        const r = stream._readableState;
        if (r && !r.errored) r.errored = er;
        if (sync) tick(onwriteError, stream, state, er, cb);
        else onwriteError(stream, state, er, cb);
        return;
    }

    if (state.buffered.length > state.bufferedIndex) {
        clearBuffer(stream, state);
    }

    if (sync) {
        // Node 24 tests `state & kDestroyed !== 0`, which is the objectMode
        // bit: object streams always take the tick
        const needTick =
            (state.needDrain && state.length === 0) ||
            state.objectMode ||
            cb !== nop;
        // the same callback written again is counted, not queued again
        if (cb === nop) {
            if (!state.afterWritePending && needTick) {
                tick(afterWrite, stream, state, 1, cb);
                state.afterWritePending = true;
            } else {
                state.pendingcb--;
                if (state.ending) finishMaybe(stream, state, true);
            }
        } else if (state.afterWriteTickInfo?.cb === cb) {
            state.afterWriteTickInfo.count++;
        } else if (needTick) {
            state.afterWriteTickInfo = { count: 1, cb, stream, state };
            tick(afterWriteTick, state.afterWriteTickInfo);
            state.afterWritePending = true;
        } else {
            state.pendingcb--;
            if (state.ending) finishMaybe(stream, state, true);
        }
    } else {
        afterWrite(stream, state, 1, cb);
    }
}

function afterWriteTick(info: TickInfo) {
    info.state.afterWriteTickInfo = null;
    afterWrite(info.stream, info.state, info.count, info.cb);
}

function afterWrite(
    stream: any,
    state: WritableState,
    count: number,
    cb: WriteCallback
) {
    state.afterWritePending = false;
    if (
        state.needDrain &&
        !state.ending &&
        !state.destroyed &&
        state.length === 0
    ) {
        state.needDrain = false;
        stream.emit("drain");
    }
    while (count-- > 0) {
        state.pendingcb--;
        cb(null);
    }
    if (state.destroyed) errorBuffer(state);
    if (state.ending) finishMaybe(stream, state, true);
}

// call the buffered writes back with the error
function errorBuffer(state: WritableState) {
    if (state.writing) return;
    const buffered = state.buffered;
    for (let n = state.bufferedIndex; n < buffered.length; ++n) {
        const { chunk, callback } = buffered[n];
        state.length -= state.objectMode ? 1 : chunk.length;
        callback(state.errored ?? ERR_STREAM_DESTROYED("write"));
    }
    callFinishedCallbacks(state, state.errored ?? ERR_STREAM_DESTROYED("end"));
    resetBuffer(state);
}

// write what is buffered: one _writev() call, or _write() one by one
function clearBuffer(stream: any, state: WritableState) {
    if (
        state.destroyed ||
        state.bufferProcessing ||
        state.corked ||
        !state.constructed
    ) {
        return;
    }
    const { buffered, bufferedIndex } = state;
    const bufferedLength = buffered.length - bufferedIndex;
    if (!bufferedLength) return;

    let i = bufferedIndex;
    state.bufferProcessing = true;
    if (bufferedLength > 1 && stream._writev) {
        state.pendingcb -= bufferedLength - 1;
        const callback = state.allNoop
            ? nop
            : (err?: any) => {
                  for (let n = i; n < buffered.length; ++n) {
                      buffered[n].callback(err);
                  }
              };
        const chunks: any =
            state.allNoop && i === 0 ? buffered : buffered.slice(i);
        chunks.allBuffers = state.allBuffers;
        doWrite(stream, state, true, state.length, chunks, "", callback);
        resetBuffer(state);
    } else {
        do {
            const { chunk, encoding, callback } = buffered[i];
            buffered[i++] = null;
            const len = state.objectMode ? 1 : chunk.length;
            doWrite(stream, state, false, len, chunk, encoding, callback);
        } while (i < buffered.length && !state.writing);

        if (i === buffered.length) {
            resetBuffer(state);
        } else if (i > 256) {
            buffered.splice(0, i);
            state.bufferedIndex = 0;
        } else {
            state.bufferedIndex = i;
        }
    }
    state.bufferProcessing = false;
}

proto._write = function (
    this: any,
    chunk: any,
    encoding: string,
    cb: WriteCallback
) {
    if (this._writev) this._writev([{ chunk, encoding }], cb);
    else throw ERR_METHOD_NOT_IMPLEMENTED("_write()");
};

proto._writev = null;

proto.end = function (
    this: any,
    chunk?: any,
    encoding?: any,
    cb?: WriteCallback
) {
    const state: WritableState = this._writableState;
    if (typeof chunk === "function") {
        cb = chunk;
        chunk = null;
        encoding = null;
    } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = null;
    }

    let err: any;
    if (chunk != null) {
        const ret = _write(this, chunk, encoding);
        if (ret instanceof Error) err = ret;
    }

    // end() uncorks fully
    if (state.corked) {
        state.corked = 1;
        this.uncork();
    }

    if (err) {
        // nothing
    } else if (!state.ending && !state.errored) {
        // forgiving: end() twice is not an error
        state.ending = true;
        finishMaybe(this, state, true);
        state.ended = true;
    } else if (state.finished) {
        err = ERR_STREAM_ALREADY_FINISHED("end");
    } else if (state.destroyed) {
        err = ERR_STREAM_DESTROYED("end");
    }

    if (typeof cb === "function") {
        if (err) tick(cb, err);
        else if (state.errored) tick(cb, state.errored);
        else if (state.finished) tick(cb, null);
        else (state.onFinished ??= []).push(cb);
    }
    return this;
};

// ended, constructed, nothing buffered or being written, no error
function needFinish(state: WritableState) {
    return (
        state.ending &&
        !state.destroyed &&
        state.constructed &&
        state.length === 0 &&
        !state.errored &&
        state.buffered.length === 0 &&
        !state.finished &&
        !state.writing &&
        !state.errorEmitted &&
        !state.closeEmitted
    );
}

function onFinish(stream: any, state: WritableState, err?: any) {
    if (state.prefinished) {
        errorOrDestroy(stream, err ?? ERR_MULTIPLE_CALLBACK());
        return;
    }
    state.pendingcb--;
    if (err) {
        callFinishedCallbacks(state, err);
        errorOrDestroy(stream, err, state.sync);
    } else if (needFinish(state)) {
        state.prefinished = true;
        stream.emit("prefinish");
        // 'finish' after the _final() callback, always asynchronously
        state.pendingcb++;
        tick(finish, stream, state);
    }
}

function prefinish(stream: any, state: WritableState) {
    if (state.prefinished || state.finalCalled) return;
    if (typeof stream._final === "function" && !state.destroyed) {
        state.finalCalled = state.sync = true;
        state.pendingcb++;
        try {
            stream._final((err?: any) => onFinish(stream, state, err));
        } catch (err) {
            onFinish(stream, state, err);
        }
        state.sync = false;
    } else {
        state.finalCalled = state.prefinished = true;
        stream.emit("prefinish");
    }
}

function finishMaybe(stream: any, state: WritableState, sync?: boolean) {
    if (needFinish(state)) {
        prefinish(stream, state);
        if (state.pendingcb === 0) {
            if (sync) {
                state.pendingcb++;
                tick(finishLater, stream, state);
            } else if (needFinish(state)) {
                state.pendingcb++;
                finish(stream, state);
            }
        }
    }
}

function finishLater(stream: any, state: WritableState) {
    if (needFinish(state)) finish(stream, state);
    else state.pendingcb--;
}

function finish(stream: any, state: WritableState) {
    state.pendingcb--;
    state.finished = true;
    callFinishedCallbacks(state, null);
    stream.emit("finish");
    if (state.autoDestroy) {
        // a Duplex waits for its readable side too
        const r = stream._readableState;
        if (!r || (r.autoDestroy && (r.endEmitted || r.readable === false))) {
            stream.destroy();
        }
    }
}

function callFinishedCallbacks(state: WritableState, err: any) {
    const callbacks = state.onFinished;
    if (callbacks === null) return;
    state.onFinished = null;
    for (let i = 0; i < callbacks.length; i++) callbacks[i](err);
}

function getter(name: string, get: (state: WritableState) => any) {
    Object.defineProperty(proto, name, {
        get(this: any) {
            return get(this._writableState);
        },
        configurable: true
    });
}

getter("closed", (w) => (w ? w.closed : false));
Object.defineProperty(proto, "destroyed", {
    get(this: any) {
        return this._writableState ? this._writableState.destroyed : false;
    },
    set(this: any, value: boolean) {
        if (this._writableState) this._writableState.destroyed = !!value;
    },
    configurable: true
});
// writable: false for the disabled side of a Duplex too
Object.defineProperty(proto, "writable", {
    get(this: any) {
        const w = this._writableState;
        return (
            !!w &&
            w.writable !== false &&
            !w.ending &&
            !w.ended &&
            !w.destroyed &&
            !w.errored
        );
    },
    set(this: any, value: boolean) {
        if (this._writableState) this._writableState.writable = !!value;
    },
    configurable: true
});
getter("writableFinished", (w) => (w ? w.finished : false));
getter("writableObjectMode", (w) => (w ? w.objectMode : false));
getter("writableBuffer", (w) => w && w.getBuffer());
getter("writableEnded", (w) => (w ? w.ending : false));
getter("writableNeedDrain", (w) =>
    w ? !w.destroyed && !w.ending && w.needDrain : false
);
getter("writableHighWaterMark", (w) => w?.highWaterMark);
getter("writableCorked", (w) => (w ? w.corked : 0));
getter("writableLength", (w) => w?.length);
getter("errored", (w) => (w ? w.errored : null));
getter(
    "writableAborted",
    (w) => w.writable !== false && (w.destroyed || !!w.errored) && !w.finished
);

proto.destroy = function (this: any, err?: any, cb?: (err?: any) => void) {
    const state: WritableState = this._writableState;
    // the pending callbacks are called
    if (
        !state.destroyed &&
        (state.buffered.length > state.bufferedIndex || state.onFinished)
    ) {
        tick(errorBuffer, state);
    }
    destroy.call(this, err, cb);
    return this;
};

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
            error = this.writableFinished ? null : new AbortError();
            this.destroy(error);
        }
        await new Promise((resolve, reject) =>
            eos(this, (err) =>
                err && err.name !== "AbortError" ? reject(err) : resolve(null)
            )
        );
    };
}
