// stream.pipeline (lib/internal/streams/pipeline.js): pipes streams, web
// streams, iterables and async generator functions into one another, and
// destroys all of them on the first error.

import { Readable } from "./readable.ts";
import { PassThrough } from "./passthrough.ts";
import { destroyer as destroyStream } from "./destroy.ts";
import { eos } from "./finished.ts";
import { duplexify } from "./duplexify.ts";
import {
    AbortError,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_RETURN_VALUE,
    ERR_MISSING_ARGS,
    ERR_STREAM_DESTROYED,
    ERR_STREAM_PREMATURE_CLOSE,
    ERR_STREAM_UNABLE_TO_PIPE,
    aggregateTwoErrors,
    isIterable,
    isNodeStream,
    isReadable,
    isReadableFinished,
    isReadableNodeStream,
    isReadableStream,
    isTransformStream,
    isWebStream,
    iterableOf,
    tick,
    validateAbortSignal,
    validateFunction
} from "./utils.ts";

type Callback = (err?: any, value?: any) => void;

function destroyer(stream: any, reading: boolean, writing: boolean) {
    let finished = false;
    stream.on("close", () => {
        finished = true;
    });
    const cleanup = eos(
        stream,
        { readable: reading, writable: writing },
        (err) => {
            finished = !err;
        }
    );
    return {
        destroy(err?: any) {
            if (finished) return;
            finished = true;
            destroyStream(stream, err || ERR_STREAM_DESTROYED("pipe"));
        },
        cleanup
    };
}

function popCallback(streams: any[]) {
    validateFunction(streams[streams.length - 1], "streams[stream.length - 1]");
    return streams.pop();
}

function makeAsyncIterable(val: any) {
    if (isIterable(val)) return val;
    if (isReadableNodeStream(val)) return fromReadable(val);
    if (isReadableStream(val)) return iterableOf(val);
    throw ERR_INVALID_ARG_TYPE(
        "val",
        ["Readable", "Iterable", "AsyncIterable"],
        val
    );
}

async function* fromReadable(val: any) {
    yield* Readable.prototype[Symbol.asyncIterator].call(val);
}

async function pumpToNode(
    iterable: any,
    writable: any,
    finish: Callback,
    { end }: { end: boolean }
) {
    let error: any;
    let onresolve: (() => void) | null = null;

    const resume = (err?: any) => {
        if (err) error = err;
        if (onresolve) {
            const callback = onresolve;
            onresolve = null;
            callback();
        }
    };

    const wait = () =>
        new Promise<void>((resolve, reject) => {
            if (error) {
                reject(error);
            } else {
                onresolve = () => {
                    if (error) reject(error);
                    else resolve();
                };
            }
        });

    writable.on("drain", resume);
    const cleanup = eos(writable, { readable: false }, resume);

    try {
        if (writable.writableNeedDrain) await wait();
        for await (const chunk of iterableOf(iterable)) {
            if (!writable.write(chunk)) await wait();
        }
        if (end) {
            writable.end();
            await wait();
        }
        finish();
    } catch (err) {
        finish(error !== err ? aggregateTwoErrors(error, err) : err);
    } finally {
        cleanup();
        writable.off("drain", resume);
    }
}

async function pumpToWeb(
    readable: any,
    writable: any,
    finish: Callback,
    { end }: { end: boolean }
) {
    if (isTransformStream(writable)) writable = writable.writable;
    const writer = writable.getWriter();
    try {
        for await (const chunk of iterableOf(readable)) {
            await writer.ready;
            writer.write(chunk).catch(() => {});
        }
        await writer.ready;
        if (end) await writer.close();
        finish();
    } catch (err) {
        try {
            await writer.abort(err);
            finish(err);
        } catch (err) {
            finish(err);
        }
    }
}

export function pipeline(...streams: any[]) {
    const callback = popCallback(streams);
    let called = false;
    return pipelineImpl(streams, (err, value) => {
        if (called) return;
        called = true;
        callback(err, value);
    });
}

export function pipelineImpl(
    streams: any[],
    callback: Callback,
    opts?: { signal?: AbortSignal; end?: boolean }
) {
    if (streams.length === 1 && Array.isArray(streams[0])) {
        streams = streams[0];
    }
    if (streams.length < 2) throw ERR_MISSING_ARGS("streams");

    const ac = new AbortController();
    const signal = ac.signal;
    const outerSignal = opts?.signal;
    const lastStreamCleanup: (() => void)[] = [];

    validateAbortSignal(outerSignal, "options.signal");

    function abort() {
        finishImpl(new AbortError(undefined, { cause: outerSignal?.reason }));
    }
    if (outerSignal) outerSignal.addEventListener("abort", abort);

    let error: any;
    let value: any;
    const destroys: ((err?: any) => void)[] = [];
    let finishCount = 0;

    function finish(err?: any) {
        finishImpl(err, --finishCount === 0);
    }

    function finishOnlyHandleError(err?: any) {
        finishImpl(err, false);
    }

    function finishImpl(err: any, final?: boolean) {
        if (
            err &&
            (!error ||
                error.code === "ERR_STREAM_PREMATURE_CLOSE" ||
                error.name === "AbortError")
        ) {
            error = err;
        }
        if (!error && !final) return;
        while (destroys.length) destroys.shift()(error);
        outerSignal?.removeEventListener("abort", abort);
        ac.abort();
        if (final) {
            if (!error) lastStreamCleanup.forEach((fn) => fn());
            tick(callback, error, value);
        }
    }

    let ret: any;
    for (let i = 0; i < streams.length; i++) {
        const stream = streams[i];
        const reading = i < streams.length - 1;
        const writing = i > 0;
        const next = i + 1 < streams.length ? streams[i + 1] : null;
        const end = reading || opts?.end !== false;
        const isLastStream = i === streams.length - 1;

        if (isNodeStream(stream)) {
            if (next !== null && (next?.closed || next?.destroyed)) {
                throw ERR_STREAM_UNABLE_TO_PIPE();
            }
            if (end) {
                const { destroy, cleanup } = destroyer(
                    stream,
                    reading,
                    writing
                );
                destroys.push(destroy);
                if (isReadable(stream) && isLastStream) {
                    lastStreamCleanup.push(cleanup);
                }
            }
            // premature closes and aborts are the destroys' business
            const onError = (err: any) => {
                if (
                    err &&
                    err.name !== "AbortError" &&
                    err.code !== "ERR_STREAM_PREMATURE_CLOSE"
                ) {
                    finishOnlyHandleError(err);
                }
            };
            stream.on("error", onError);
            if (isReadable(stream) && isLastStream) {
                lastStreamCleanup.push(() => {
                    stream.removeListener("error", onError);
                });
            }
        }

        if (i === 0) {
            if (typeof stream === "function") {
                ret = stream({ signal });
                if (!isIterable(ret)) {
                    throw ERR_INVALID_RETURN_VALUE(
                        "Iterable, AsyncIterable or Stream",
                        "source",
                        ret
                    );
                }
            } else if (
                isIterable(stream) ||
                isReadableNodeStream(stream) ||
                isTransformStream(stream) ||
                isReadableStream(stream)
            ) {
                ret = stream;
            } else {
                ret = duplexify(stream, "body");
            }
        } else if (typeof stream === "function") {
            ret = makeAsyncIterable(
                isTransformStream(ret) ? ret?.readable : ret
            );
            ret = stream(ret, { signal });

            if (reading) {
                if (!isIterable(ret, true)) {
                    throw ERR_INVALID_RETURN_VALUE(
                        "AsyncIterable",
                        `transform[${i - 1}]`,
                        ret
                    );
                }
            } else {
                // the last function's result goes through a PassThrough
                const pt = new (PassThrough as any)({ objectMode: true });
                const then = ret?.then;
                if (typeof then === "function") {
                    finishCount++;
                    then.call(
                        ret,
                        (val: any) => {
                            value = val;
                            if (val != null) pt.write(val);
                            if (end) pt.end();
                            tick(finish);
                        },
                        (err: any) => {
                            pt.destroy(err);
                            tick(finish, err);
                        }
                    );
                } else if (isIterable(ret, true)) {
                    finishCount++;
                    pumpToNode(ret, pt, finish, { end });
                } else if (isReadableStream(ret) || isTransformStream(ret)) {
                    finishCount++;
                    pumpToNode(ret.readable || ret, pt, finish, { end });
                } else {
                    throw ERR_INVALID_RETURN_VALUE(
                        "AsyncIterable or Promise",
                        "destination",
                        ret
                    );
                }
                ret = pt;
                const { destroy, cleanup } = destroyer(ret, false, true);
                destroys.push(destroy);
                if (isLastStream) lastStreamCleanup.push(cleanup);
            }
        } else if (isNodeStream(stream)) {
            if (isReadableNodeStream(ret)) {
                finishCount += 2;
                const cleanup = pipe(
                    ret,
                    stream,
                    finish,
                    finishOnlyHandleError,
                    { end }
                );
                if (isReadable(stream) && isLastStream) {
                    lastStreamCleanup.push(cleanup);
                }
            } else if (isTransformStream(ret) || isReadableStream(ret)) {
                finishCount++;
                pumpToNode(ret.readable || ret, stream, finish, { end });
            } else if (isIterable(ret)) {
                finishCount++;
                pumpToNode(ret, stream, finish, { end });
            } else {
                throw ERR_INVALID_ARG_TYPE(
                    "val",
                    [
                        "Readable",
                        "Iterable",
                        "AsyncIterable",
                        "ReadableStream",
                        "TransformStream"
                    ],
                    ret
                );
            }
            ret = stream;
        } else if (isWebStream(stream)) {
            if (isReadableNodeStream(ret)) {
                finishCount++;
                pumpToWeb(makeAsyncIterable(ret), stream, finish, { end });
            } else if (isReadableStream(ret) || isIterable(ret)) {
                finishCount++;
                pumpToWeb(ret, stream, finish, { end });
            } else if (isTransformStream(ret)) {
                finishCount++;
                pumpToWeb(ret.readable, stream, finish, { end });
            } else {
                throw ERR_INVALID_ARG_TYPE(
                    "val",
                    [
                        "Readable",
                        "Iterable",
                        "AsyncIterable",
                        "ReadableStream",
                        "TransformStream"
                    ],
                    ret
                );
            }
            ret = stream;
        } else {
            ret = duplexify(stream, "body");
        }
    }

    if (signal?.aborted || outerSignal?.aborted) tick(abort);
    return ret;
}

function pipe(
    src: any,
    dst: any,
    finish: Callback,
    finishOnlyHandleError: Callback,
    { end }: { end: boolean }
) {
    let ended = false;
    dst.on("close", () => {
        if (!ended) {
            // the destination closed before the source ended
            finishOnlyHandleError(ERR_STREAM_PREMATURE_CLOSE());
        }
    });

    // the end listener below ends dst
    src.pipe(dst, { end: false });

    if (end) {
        const endFn = () => {
            ended = true;
            dst.end();
        };
        if (isReadableFinished(src)) tick(endFn);
        else src.once("end", endFn);
    } else {
        finish();
    }

    eos(src, { readable: true, writable: false }, (err) => {
        const rState = src._readableState;
        if (
            err &&
            err.code === "ERR_STREAM_PREMATURE_CLOSE" &&
            rState?.ended &&
            !rState.errored &&
            !rState.errorEmitted
        ) {
            // closed after the end, before 'end' was emitted: wait for it
            src.once("end", finish).once("error", finish);
        } else {
            finish(err);
        }
    });
    return eos(dst, { readable: false, writable: true }, finish);
}
