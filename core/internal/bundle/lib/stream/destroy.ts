// destroy() and the error path shared by Readable and Writable
// (lib/internal/streams/destroy.js): 'error' then 'close', each once, on the
// tick after _destroy() calls back; _construct() delays both.

import {
    AbortError,
    ERR_MULTIPLE_CALLBACK,
    aggregateTwoErrors,
    isDestroyed,
    isFinished,
    isRequest,
    kIsDestroyed,
    tick
} from "./utils.ts";

export const kDestroy = Symbol("kDestroy");
export const kConstruct = Symbol("kConstruct");

function checkError(err: any, w: any, r: any) {
    if (err) {
        if (w && !w.errored) w.errored = err;
        if (r && !r.errored) r.errored = err;
    }
}

export function destroy(this: any, err?: any, cb?: (err?: any) => void) {
    const r = this._readableState;
    const w = this._writableState;
    const s = w || r;

    if (w?.destroyed || r?.destroyed) {
        if (typeof cb === "function") cb();
        return this;
    }

    checkError(err, w, r);
    if (w) w.destroyed = true;
    if (r) r.destroyed = true;

    if (!s.constructed) {
        this.once(kDestroy, function (this: any, er: any) {
            _destroy(this, aggregateTwoErrors(er, err), cb);
        });
    } else {
        _destroy(this, err, cb);
    }
    return this;
}

function _destroy(self: any, err: any, cb?: (err?: any) => void) {
    let called = false;
    function onDestroy(err?: any) {
        if (called) return;
        called = true;
        const r = self._readableState;
        const w = self._writableState;
        checkError(err, w, r);
        if (w) w.closed = true;
        if (r) r.closed = true;
        if (typeof cb === "function") cb(err);
        if (err) tick(emitErrorCloseNT, self, err);
        else tick(emitCloseNT, self);
    }
    try {
        self._destroy(err || null, onDestroy);
    } catch (err) {
        onDestroy(err);
    }
}

function emitErrorCloseNT(self: any, err: any) {
    emitErrorNT(self, err);
    emitCloseNT(self);
}

function emitCloseNT(self: any) {
    const r = self._readableState;
    const w = self._writableState;
    if (w) w.closeEmitted = true;
    if (r) r.closeEmitted = true;
    if (w?.emitClose || r?.emitClose) self.emit("close");
}

export function emitErrorNT(self: any, err: any) {
    const r = self._readableState;
    const w = self._writableState;
    if (w?.errorEmitted || r?.errorEmitted) return;
    if (w) w.errorEmitted = true;
    if (r) r.errorEmitted = true;
    self.emit("error", err);
}

export function undestroy(this: any) {
    const r = this._readableState;
    const w = this._writableState;
    if (r) {
        r.constructed = true;
        r.closed = false;
        r.closeEmitted = false;
        r.destroyed = false;
        r.errored = null;
        r.errorEmitted = false;
        r.reading = false;
        r.ended = r.readable === false;
        r.endEmitted = r.readable === false;
    }
    if (w) {
        w.constructed = true;
        w.destroyed = false;
        w.closed = false;
        w.closeEmitted = false;
        w.errored = null;
        w.errorEmitted = false;
        w.finalCalled = false;
        w.prefinished = false;
        w.ended = w.writable === false;
        w.ending = w.writable === false;
        w.finished = w.writable === false;
    }
}

// destroy(err) when autoDestroy, else only 'error' (sync: on the next tick)
export function errorOrDestroy(stream: any, err: any, sync?: boolean) {
    const r = stream._readableState;
    const w = stream._writableState;
    if (w?.destroyed || r?.destroyed) return;
    if (r?.autoDestroy || w?.autoDestroy) {
        stream.destroy(err);
    } else if (err) {
        if (w && !w.errored) w.errored = err;
        if (r && !r.errored) r.errored = err;
        if (sync) tick(emitErrorNT, stream, err);
        else emitErrorNT(stream, err);
    }
}

// _construct(cb): the stream waits for cb before _read, _write or _destroy
export function construct(stream: any, cb: () => void) {
    if (typeof stream._construct !== "function") return;
    const r = stream._readableState;
    const w = stream._writableState;
    if (r) r.constructed = false;
    if (w) w.constructed = false;
    stream.once(kConstruct, cb);
    if (stream.listenerCount(kConstruct) > 1) return; // duplex
    tick(constructNT, stream);
}

function constructNT(stream: any) {
    let called = false;
    function onConstruct(err?: any) {
        if (called) {
            errorOrDestroy(stream, err ?? ERR_MULTIPLE_CALLBACK());
            return;
        }
        called = true;
        const r = stream._readableState;
        const w = stream._writableState;
        const s = w || r;
        if (r) r.constructed = true;
        if (w) w.constructed = true;
        if (s.destroyed) stream.emit(kDestroy, err);
        else if (err) errorOrDestroy(stream, err, true);
        else stream.emit(kConstruct);
    }
    try {
        stream._construct((err?: any) => tick(onConstruct, err));
    } catch (err) {
        tick(onConstruct, err);
    }
}

function emitCloseLegacy(stream: any) {
    stream.emit("close");
}

function emitErrorCloseLegacy(stream: any, err: any) {
    stream.emit("error", err);
    tick(emitCloseLegacy, stream);
}

// stream.destroy(stream, err): any stream-like object
export function destroyer(stream: any, err?: any) {
    if (!stream || isDestroyed(stream)) return;
    if (!err && !isFinished(stream)) err = new AbortError();
    if (isRequest(stream)) stream.abort();
    else if (isRequest(stream.req)) stream.req.abort();
    else if (typeof stream.destroy === "function") stream.destroy(err);
    else if (typeof stream.close === "function") stream.close();
    else if (err) tick(emitErrorCloseLegacy, stream, err);
    else tick(emitCloseLegacy, stream);
    if (!stream.destroyed) stream[kIsDestroyed] = true;
}
