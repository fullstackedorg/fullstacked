// The internals every stream module shares: the deferral queue, Node's
// errors, the stream predicates of lib/internal/streams/utils.js and the
// default highWaterMarks of lib/internal/streams/state.js.

import {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE,
    ERR_UNKNOWN_ENCODING,
    validateInteger
} from "../buffer/errors.ts";

export {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE,
    ERR_UNKNOWN_ENCODING
};

export type Callback = (err?: any, value?: any) => void;
export type AnyStream = any;

export function nop() {}

// Deferral. Node defers with process.nextTick, which in the webview is a
// timer (lib/process): a timer per chunk is what made readable-stream slow
// there, and hidden pages throttle timers. The queue below runs on one
// microtask per batch, and keeps Node's order: the callbacks run first in,
// first out, and the ones queued while it drains run in the same drain,
// before the promise reactions queued meanwhile, as the nextTick queue does.
// An entry is a function and up to four arguments, so that the hot paths
// queue no closure.

const queue: any[] = [];
let head = 0;
let scheduled = false;

// Drains run as reactions of a resolved promise: on V8 (Chrome, the
// Android WebView) a queueMicrotask costs about 8 times a promise reaction,
// and `for await` over Readable.from drains once per object.
const resolved = Promise.resolve();

function drain() {
    try {
        while (head < queue.length) {
            const i = head;
            const fn = queue[i];
            const a = queue[i + 1];
            const b = queue[i + 2];
            const c = queue[i + 3];
            const d = queue[i + 4];
            queue[i] = queue[i + 1] = queue[i + 2] = undefined;
            queue[i + 3] = queue[i + 4] = undefined;
            head = i + 5;
            fn(a, b, c, d);
        }
    } catch (error) {
        // reported as uncaught (a throw in a promise reaction would be an
        // unhandled rejection), then the rest runs on the next microtask
        queueMicrotask(() => {
            throw error;
        });
        if (head < queue.length) {
            resolved.then(drain);
            return;
        }
    }
    queue.length = 0;
    head = 0;
    scheduled = false;
}

export function tick(
    fn: (a?: any, b?: any, c?: any, d?: any) => void,
    a?: any,
    b?: any,
    c?: any,
    d?: any
) {
    queue.push(fn, a, b, c, d);
    if (!scheduled) {
        scheduled = true;
        resolved.then(drain);
    }
}

// errors with Node's codes and messages (lib/internal/errors.js)

type NodeError = Error & { code: string };

function nodeError(
    Base: ErrorConstructor,
    code: string,
    message: string,
    options?: ErrorOptions
): NodeError {
    const error = new Base(message, options) as NodeError;
    Object.defineProperty(error, "toString", {
        value() {
            return `${this.name} [${code}]: ${this.message}`;
        },
        writable: true,
        configurable: true
    });
    error.code = code;
    return error;
}

export const ERR_STREAM_PUSH_AFTER_EOF = () =>
    nodeError(Error, "ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
export const ERR_STREAM_UNSHIFT_AFTER_END_EVENT = () =>
    nodeError(
        Error,
        "ERR_STREAM_UNSHIFT_AFTER_END_EVENT",
        "stream.unshift() after end event"
    );
export const ERR_STREAM_WRITE_AFTER_END = () =>
    nodeError(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end");
export const ERR_STREAM_DESTROYED = (name: string) =>
    nodeError(
        Error,
        "ERR_STREAM_DESTROYED",
        `Cannot call ${name} after a stream was destroyed`
    );
export const ERR_STREAM_ALREADY_FINISHED = (name: string) =>
    nodeError(
        Error,
        "ERR_STREAM_ALREADY_FINISHED",
        `Cannot call ${name} after a stream was finished`
    );
export const ERR_STREAM_PREMATURE_CLOSE = () =>
    nodeError(Error, "ERR_STREAM_PREMATURE_CLOSE", "Premature close");
export const ERR_STREAM_CANNOT_PIPE = () =>
    nodeError(Error, "ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
export const ERR_STREAM_UNABLE_TO_PIPE = () =>
    nodeError(
        Error,
        "ERR_STREAM_UNABLE_TO_PIPE",
        "Cannot pipe to a closed or destroyed stream"
    );
export const ERR_STREAM_NULL_VALUES = () =>
    nodeError(
        TypeError,
        "ERR_STREAM_NULL_VALUES",
        "May not write null values to stream"
    );
export const ERR_MULTIPLE_CALLBACK = () =>
    nodeError(Error, "ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
export const ERR_METHOD_NOT_IMPLEMENTED = (name: string) =>
    nodeError(
        Error,
        "ERR_METHOD_NOT_IMPLEMENTED",
        `The ${name} method is not implemented`
    );
export const ERR_ILLEGAL_CONSTRUCTOR = () =>
    nodeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
export const ERR_INVALID_STATE = (message: string) =>
    nodeError(Error, "ERR_INVALID_STATE", `Invalid state: ${message}`);
export function ERR_INVALID_RETURN_VALUE(
    input: string,
    name: string,
    value: unknown
) {
    const type = value?.constructor?.name
        ? `instance of ${value.constructor.name}`
        : `type ${typeof value}`;
    return nodeError(
        TypeError,
        "ERR_INVALID_RETURN_VALUE",
        `Expected ${input} to be returned from the "${name}" function but got ${type}.`
    );
}

export class AbortError extends Error {
    code = "ABORT_ERR";
    constructor(message = "The operation was aborted", options?: ErrorOptions) {
        super(message, options);
        this.name = "AbortError";
    }
}

export function abortError(signal?: AbortSignal) {
    return new AbortError(undefined, { cause: signal?.reason });
}

export function aggregateTwoErrors(inner: any, outer: any) {
    if (inner && outer && inner !== outer) {
        if (Array.isArray(outer.errors)) {
            outer.errors.push(inner);
            return outer;
        }
        const error: any = new AggregateError([outer, inner], outer.message);
        error.code = outer.code;
        return error;
    }
    return inner || outer;
}

// validators

export function validateFunction(value: unknown, name: string) {
    if (typeof value !== "function") {
        throw ERR_INVALID_ARG_TYPE(name, "Function", value);
    }
}

export function validateObject(value: unknown, name: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw ERR_INVALID_ARG_TYPE(name, "Object", value);
    }
}

export function validateBoolean(value: unknown, name: string) {
    if (typeof value !== "boolean") {
        throw ERR_INVALID_ARG_TYPE(name, "boolean", value);
    }
}

export function validateAbortSignal(signal: unknown, name: string) {
    if (
        signal !== undefined &&
        (signal === null ||
            typeof signal !== "object" ||
            !("aborted" in signal))
    ) {
        throw ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
    }
}

// an abort listener that the returned function removes
export function onAbort(signal: AbortSignal, fn: () => void) {
    if (signal.aborted) {
        queueMicrotask(fn);
        return nop;
    }
    signal.addEventListener("abort", fn, { once: true });
    return () => signal.removeEventListener("abort", fn);
}

// highWaterMark (lib/internal/streams/state.js); 64 KiB is Node's default
// outside Windows

let defaultBytes = 64 * 1024;
let defaultObjects = 16;

export function getDefaultHighWaterMark(objectMode?: boolean) {
    return objectMode ? defaultObjects : defaultBytes;
}

export function setDefaultHighWaterMark(objectMode: boolean, value: number) {
    validateInteger(value, "value", 0);
    if (objectMode) defaultObjects = value;
    else defaultBytes = value;
}

export function getHighWaterMark(
    objectMode: boolean,
    options: any,
    duplexKey: string,
    isDuplex: boolean
): number {
    const hwm =
        options.highWaterMark != null
            ? options.highWaterMark
            : isDuplex
              ? options[duplexKey]
              : null;
    if (hwm != null) {
        if (!Number.isInteger(hwm) || hwm < 0) {
            const name = isDuplex
                ? `options.${duplexKey}`
                : "options.highWaterMark";
            throw ERR_INVALID_ARG_VALUE(name, hwm);
        }
        return Math.floor(hwm);
    }
    return objectMode ? defaultObjects : defaultBytes;
}

// predicates (lib/internal/streams/utils.js)

export const kIsDestroyed = Symbol.for("nodejs.stream.destroyed");
export const kIsErrored = Symbol.for("nodejs.stream.errored");
export const kIsReadable = Symbol.for("nodejs.stream.readable");
export const kIsWritable = Symbol.for("nodejs.stream.writable");
export const kIsDisturbed = Symbol.for("nodejs.stream.disturbed");
export const kIsClosedPromise = Symbol.for("nodejs.webstream.isClosedPromise");
export const kControllerErrorFunction = Symbol.for(
    "nodejs.webstream.controllerErrorFunction"
);

export function isReadableNodeStream(obj: any, strict = false) {
    return !!(
        obj &&
        typeof obj.pipe === "function" &&
        typeof obj.on === "function" &&
        (!strict ||
            (typeof obj.pause === "function" &&
                typeof obj.resume === "function")) &&
        (!obj._writableState || obj._readableState?.readable !== false) &&
        (!obj._writableState || obj._readableState)
    );
}

export function isWritableNodeStream(obj: any) {
    return !!(
        obj &&
        typeof obj.write === "function" &&
        typeof obj.on === "function" &&
        (!obj._readableState || obj._writableState?.writable !== false)
    );
}

export function isDuplexNodeStream(obj: any) {
    return !!(
        obj &&
        typeof obj.pipe === "function" &&
        obj._readableState &&
        typeof obj.on === "function" &&
        typeof obj.write === "function"
    );
}

export function isNodeStream(obj: any) {
    return (
        obj &&
        (obj._readableState ||
            obj._writableState ||
            (typeof obj.write === "function" && typeof obj.on === "function") ||
            (typeof obj.pipe === "function" && typeof obj.on === "function"))
    );
}

export function isReadableStream(obj: any) {
    return !!(
        obj &&
        !isNodeStream(obj) &&
        typeof obj.pipeThrough === "function" &&
        typeof obj.getReader === "function" &&
        typeof obj.cancel === "function"
    );
}

export function isWritableStream(obj: any) {
    return !!(
        obj &&
        !isNodeStream(obj) &&
        typeof obj.getWriter === "function" &&
        typeof obj.abort === "function"
    );
}

export function isTransformStream(obj: any) {
    return !!(
        obj &&
        !isNodeStream(obj) &&
        typeof obj.readable === "object" &&
        typeof obj.writable === "object"
    );
}

export function isWebStream(obj: any) {
    return (
        isReadableStream(obj) || isWritableStream(obj) || isTransformStream(obj)
    );
}

export function isIterable(obj: any, isAsync?: boolean) {
    if (obj == null) return false;
    if (isAsync === true)
        return typeof obj[Symbol.asyncIterator] === "function";
    if (isAsync === false) return typeof obj[Symbol.iterator] === "function";
    return (
        typeof obj[Symbol.asyncIterator] === "function" ||
        typeof obj[Symbol.iterator] === "function"
    );
}

// a web ReadableStream as an async iterable: JavaScriptCore's has no
// Symbol.asyncIterator
export function webIterable(stream: ReadableStream): AsyncIterable<any> {
    if (typeof (stream as any)[Symbol.asyncIterator] === "function") {
        return stream as any;
    }
    return {
        async *[Symbol.asyncIterator]() {
            const reader = stream.getReader();
            let done = false;
            try {
                while (true) {
                    const result = await reader.read();
                    if (result.done) {
                        done = true;
                        return;
                    }
                    yield result.value;
                }
            } finally {
                if (!done) await reader.cancel();
                reader.releaseLock();
            }
        }
    };
}

// iterable or web stream, as an iterable
export function iterableOf(obj: any) {
    return isReadableStream(obj) ? webIterable(obj) : obj;
}

export function isDestroyed(stream: any) {
    if (!isNodeStream(stream)) return null;
    const state = stream._writableState || stream._readableState;
    return !!(stream.destroyed || stream[kIsDestroyed] || state?.destroyed);
}

export function isWritableEnded(stream: any) {
    if (!isWritableNodeStream(stream)) return null;
    if (stream.writableEnded === true) return true;
    const w = stream._writableState;
    if (w?.errored) return false;
    if (typeof w?.ended !== "boolean") return null;
    return w.ended;
}

export function isWritableFinished(stream: any, strict?: boolean) {
    if (!isWritableNodeStream(stream)) return null;
    if (stream.writableFinished === true) return true;
    const w = stream._writableState;
    if (w?.errored) return false;
    if (typeof w?.finished !== "boolean") return null;
    return !!(
        w.finished ||
        (strict === false && w.ended === true && w.length === 0)
    );
}

export function isReadableFinished(stream: any, strict?: boolean) {
    if (!isReadableNodeStream(stream)) return null;
    const r = stream._readableState;
    if (r?.errored) return false;
    if (typeof r?.endEmitted !== "boolean") return null;
    return !!(
        r.endEmitted ||
        (strict === false && r.ended === true && r.length === 0)
    );
}

export function isReadable(stream: any) {
    if (stream && stream[kIsReadable] != null) return stream[kIsReadable];
    if (typeof stream?.readable !== "boolean") return null;
    if (isDestroyed(stream)) return false;
    return (
        isReadableNodeStream(stream) &&
        stream.readable &&
        !isReadableFinished(stream)
    );
}

export function isWritable(stream: any) {
    if (stream && stream[kIsWritable] != null) return stream[kIsWritable];
    if (typeof stream?.writable !== "boolean") return null;
    if (isDestroyed(stream)) return false;
    return (
        isWritableNodeStream(stream) &&
        stream.writable &&
        !isWritableEnded(stream)
    );
}

export function isFinished(stream: any, opts?: any) {
    if (!isNodeStream(stream)) return null;
    if (isDestroyed(stream)) return true;
    if (opts?.readable !== false && isReadable(stream)) return false;
    if (opts?.writable !== false && isWritable(stream)) return false;
    return true;
}

export function isWritableErrored(stream: any) {
    if (!isNodeStream(stream)) return null;
    if (stream.writableErrored) return stream.writableErrored;
    return stream._writableState?.errored ?? null;
}

export function isReadableErrored(stream: any) {
    if (!isNodeStream(stream)) return null;
    if (stream.readableErrored) return stream.readableErrored;
    return stream._readableState?.errored ?? null;
}

export function isClosed(stream: any) {
    if (!isNodeStream(stream)) return null;
    if (typeof stream.closed === "boolean") return stream.closed;
    const w = stream._writableState;
    const r = stream._readableState;
    if (typeof w?.closed === "boolean" || typeof r?.closed === "boolean") {
        return w?.closed || r?.closed;
    }
    return null;
}

export function willEmitClose(stream: any) {
    if (!isNodeStream(stream)) return null;
    const state = stream._writableState || stream._readableState;
    return !!(state?.autoDestroy && state.emitClose && state.closed === false);
}

export function isDisturbed(stream: any) {
    return !!(
        stream &&
        (stream[kIsDisturbed] ??
            (stream.readableDidRead || stream.readableAborted))
    );
}

export function isErrored(stream: any) {
    return !!(
        stream &&
        (stream[kIsErrored] ??
            stream.readableErrored ??
            stream.writableErrored ??
            stream._readableState?.errorEmitted ??
            stream._writableState?.errorEmitted ??
            stream._readableState?.errored ??
            stream._writableState?.errored)
    );
}

export function isRequest(stream: any) {
    return stream?.setHeader && typeof stream.abort === "function";
}
