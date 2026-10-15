// stream.finished (lib/internal/streams/end-of-stream.js): calls back once a
// stream has ended, finished, errored or closed early, and returns the
// function that removes its listeners.

import {
    ERR_INVALID_ARG_TYPE,
    ERR_STREAM_PREMATURE_CLOSE,
    abortError,
    isClosed,
    isNodeStream,
    isReadable,
    isReadableErrored,
    isReadableFinished,
    isReadableNodeStream,
    isReadableStream,
    isRequest,
    isWritable,
    isWritableErrored,
    isWritableFinished,
    isWritableNodeStream,
    isWritableStream,
    kIsClosedPromise,
    nop,
    onAbort,
    tick,
    validateAbortSignal,
    validateBoolean,
    validateFunction,
    validateObject,
    willEmitClose as _willEmitClose
} from "./utils.ts";

type Options = {
    readable?: boolean;
    writable?: boolean;
    error?: boolean;
    signal?: AbortSignal;
    cleanup?: boolean;
};

function once(fn: Function) {
    let called = false;
    return function (this: any, ...args: any[]) {
        if (called) return;
        called = true;
        return fn.apply(this, args);
    };
}

export function eos(
    stream: any,
    options: Options | ((err?: any) => void),
    callback?: (err?: any) => void
): () => void {
    if (arguments.length === 2) {
        callback = options as (err?: any) => void;
        options = {};
    } else if (options == null) {
        options = {};
    } else {
        validateObject(options, "options");
    }
    const opts = options as Options;
    validateFunction(callback, "callback");
    validateAbortSignal(opts.signal, "options.signal");

    callback = once(callback);

    if (isReadableStream(stream) || isWritableStream(stream)) {
        return eosWeb(stream, opts, callback);
    }
    if (!isNodeStream(stream)) {
        throw ERR_INVALID_ARG_TYPE(
            "stream",
            ["ReadableStream", "WritableStream", "Stream"],
            stream
        );
    }

    const readable = opts.readable ?? isReadableNodeStream(stream);
    const writable = opts.writable ?? isWritableNodeStream(stream);
    const wState = stream._writableState;
    const rState = stream._readableState;

    const onlegacyfinish = () => {
        if (!stream.writable) onfinish();
    };

    let willEmitClose =
        _willEmitClose(stream) &&
        isReadableNodeStream(stream) === readable &&
        isWritableNodeStream(stream) === writable;

    let writableFinished = isWritableFinished(stream, false);
    const onfinish = () => {
        writableFinished = true;
        if (stream.destroyed) willEmitClose = false;
        if (willEmitClose && (!stream.readable || readable)) return;
        if (!readable || readableFinished) callback.call(stream);
    };

    let readableFinished = isReadableFinished(stream, false);
    const onend = () => {
        readableFinished = true;
        if (stream.destroyed) willEmitClose = false;
        if (willEmitClose && (!stream.writable || writable)) return;
        if (!writable || writableFinished) callback.call(stream);
    };

    const onerror = (err: any) => {
        callback.call(stream, err);
    };

    let closed = isClosed(stream);

    const onclose = () => {
        closed = true;
        const errored = isWritableErrored(stream) || isReadableErrored(stream);
        if (errored && typeof errored !== "boolean") {
            return callback.call(stream, errored);
        }
        if (
            readable &&
            !readableFinished &&
            isReadableNodeStream(stream, true) &&
            !isReadableFinished(stream, false)
        ) {
            return callback.call(stream, ERR_STREAM_PREMATURE_CLOSE());
        }
        if (
            writable &&
            !writableFinished &&
            !isWritableFinished(stream, false)
        ) {
            return callback.call(stream, ERR_STREAM_PREMATURE_CLOSE());
        }
        callback.call(stream);
    };

    const onclosed = () => {
        closed = true;
        const errored = isWritableErrored(stream) || isReadableErrored(stream);
        if (errored && typeof errored !== "boolean") {
            return callback.call(stream, errored);
        }
        callback.call(stream);
    };

    const onrequest = () => {
        stream.req.on("finish", onfinish);
    };

    if (isRequest(stream)) {
        stream.on("complete", onfinish);
        if (!willEmitClose) stream.on("abort", onclose);
        if (stream.req) onrequest();
        else stream.on("request", onrequest);
    } else if (writable && !wState) {
        // legacy streams
        stream.on("end", onlegacyfinish);
        stream.on("close", onlegacyfinish);
    }

    if (!willEmitClose && typeof stream.aborted === "boolean") {
        stream.on("aborted", onclose);
    }

    stream.on("end", onend);
    stream.on("finish", onfinish);
    if (opts.error !== false) stream.on("error", onerror);
    stream.on("close", onclose);

    if (closed) {
        tick(onclose);
    } else if (wState?.errorEmitted || rState?.errorEmitted) {
        if (!willEmitClose) tick(onclosed);
    } else if (
        !readable &&
        (!willEmitClose || isReadable(stream)) &&
        (writableFinished || isWritable(stream) === false) &&
        (wState == null ||
            wState.pendingcb === undefined ||
            wState.pendingcb === 0)
    ) {
        tick(onclosed);
    } else if (
        !writable &&
        (!willEmitClose || isWritable(stream)) &&
        (readableFinished || isReadable(stream) === false)
    ) {
        tick(onclosed);
    } else if (rState && stream.req && stream.aborted) {
        tick(onclosed);
    }

    const cleanup = () => {
        callback = nop;
        stream.removeListener("aborted", onclose);
        stream.removeListener("complete", onfinish);
        stream.removeListener("abort", onclose);
        stream.removeListener("request", onrequest);
        if (stream.req) stream.req.removeListener("finish", onfinish);
        stream.removeListener("end", onlegacyfinish);
        stream.removeListener("close", onlegacyfinish);
        stream.removeListener("finish", onfinish);
        stream.removeListener("end", onend);
        stream.removeListener("error", onerror);
        stream.removeListener("close", onclose);
    };

    if (opts.signal && !closed) {
        const signal = opts.signal;
        const abort = () => {
            const endCallback = callback;
            cleanup();
            endCallback.call(stream, abortError(signal));
        };
        if (signal.aborted) {
            tick(abort);
        } else {
            const remove = onAbort(signal, abort);
            const original = callback;
            callback = once(function (this: any, ...args: any[]) {
                remove();
                (original as Function).apply(stream, args);
            });
        }
    }

    return cleanup;
}

// web streams: Node's own carry a closed promise; the webview's do not, and
// there is no way to observe a ReadableStream or WritableStream closing
// without locking it, so only the signal can end the wait there
function eosWeb(stream: any, options: Options, callback: Function) {
    let isAborted = false;
    if (options.signal) {
        const signal = options.signal;
        const abort = () => {
            isAborted = true;
            callback.call(stream, abortError(signal));
        };
        if (signal.aborted) {
            tick(abort);
        } else {
            const remove = onAbort(signal, abort);
            const original = callback;
            callback = once((...args: any[]) => {
                remove();
                original.apply(stream, args);
            });
        }
    }
    const resolverFn = (...args: any[]) => {
        if (!isAborted) tick(() => callback.apply(stream, args));
    };
    stream[kIsClosedPromise]?.promise.then(resolverFn, resolverFn);
    return nop;
}

export function finished(stream: any, opts?: Options) {
    let autoCleanup = false;
    if (opts === null) opts = {};
    if (opts?.cleanup) {
        validateBoolean(opts.cleanup, "cleanup");
        autoCleanup = opts.cleanup;
    }
    return new Promise<void>((resolve, reject) => {
        const cleanup = eos(stream, opts, (err) => {
            if (autoCleanup) cleanup();
            if (err) reject(err);
            else resolve();
        });
    });
}
