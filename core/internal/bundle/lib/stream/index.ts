// node:stream (Node 24), improvements/shim/plan.md 5.4: written from Node's behavior and
// lib/internal/streams, not from readable-stream. The classes are function
// constructors, so that both `class X extends Transform` and the npm way,
// `Transform.call(this)` with `inherits(X, Transform)`, work.
//
// Node defers with process.nextTick; here every deferral goes through one
// microtask queue (utils.ts tick), in Node's order.
//
// `require("stream")` gets Stream, the legacy base class, with every class
// and function on it, as in Node: it is the "module.exports" export
// (bundle.go, libRequireAdapter).

import type * as NodeStream from "node:stream";
import { Stream } from "./legacy.ts";
import { Readable } from "./readable.ts";
import { Writable } from "./writable.ts";
import { Duplex } from "./duplex.ts";
import { Transform } from "./transform.ts";
import { PassThrough } from "./passthrough.ts";
import { duplexPair } from "./duplexPair.ts";
import { from } from "./from.ts";
import { pipeline } from "./pipeline.ts";
import { eos } from "./finished.ts";
import { destroyer } from "./destroy.ts";
import { compose } from "./compose.ts";
import { duplexify } from "./duplexify.ts";
import { addAbortSignal, addAbortSignalNoValidate } from "./addAbortSignal.ts";
import {
    promiseReturningOperators,
    streamReturningOperators
} from "./operators.ts";
import {
    newReadableStreamFromStreamReadable,
    newReadableWritablePairFromDuplex,
    newStreamDuplexFromReadableWritablePair,
    newStreamReadableFromReadableStream,
    newStreamWritableFromWritableStream,
    newWritableStreamFromStreamWritable
} from "./adapters.ts";
import promises from "./promises.ts";
import { Buffer } from "../buffer/index.ts";
import {
    ERR_ILLEGAL_CONSTRUCTOR,
    getDefaultHighWaterMark,
    isDestroyed,
    isDisturbed,
    isErrored,
    isReadable,
    isWritable,
    setDefaultHighWaterMark,
    validateAbortSignal,
    validateObject
} from "./utils.ts";

const R = Readable as any;
const W = Writable as any;
const D = Duplex as any;

R.from = (iterable: any, opts?: any) => from(Readable, iterable, opts);
R.fromWeb = newStreamReadableFromReadableStream;
R.toWeb = newReadableStreamFromStreamReadable;
W.fromWeb = newStreamWritableFromWritableStream;
W.toWeb = newWritableStreamFromStreamWritable;
D.from = (body: any) => duplexify(body, "body");
D.fromWeb = newStreamDuplexFromReadableWritablePair;
D.toWeb = newReadableWritablePairFromDuplex;

R.prototype.compose = function compose_(this: any, stream: any, options?: any) {
    if (options != null) validateObject(options, "options");
    if (options?.signal != null) {
        validateAbortSignal(options.signal, "options.signal");
    }
    const composed = compose(this, stream);
    if (options?.signal) addAbortSignalNoValidate(options.signal, composed);
    return composed;
};

// the operators: non-enumerable methods, not constructors
function defineOperator(key: string, op: Function, toStream: boolean) {
    const fn = function (this: any, ...args: any[]) {
        if (new.target) throw ERR_ILLEGAL_CONSTRUCTOR();
        const result = op.apply(this, args);
        return toStream ? R.from(result) : result;
    };
    Object.defineProperty(fn, "name", { value: op.name });
    Object.defineProperty(fn, "length", { value: op.length });
    Object.defineProperty(R.prototype, key, {
        value: fn,
        enumerable: false,
        configurable: true,
        writable: true
    });
}
for (const [key, op] of Object.entries(streamReturningOperators)) {
    defineOperator(key, op, true);
}
for (const [key, op] of Object.entries(promiseReturningOperators)) {
    defineOperator(key, op, false);
}

function isArrayBufferView(value: unknown) {
    return ArrayBuffer.isView(value);
}
function isUint8Array(value: unknown) {
    return value instanceof Uint8Array;
}
function uint8ArrayToBuffer(chunk: Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

const customPromisify = Symbol.for("nodejs.util.promisify.custom");
Object.defineProperty(pipeline, customPromisify, {
    enumerable: true,
    get: () => promises.pipeline
});
Object.defineProperty(eos, customPromisify, {
    enumerable: true,
    get: () => promises.finished
});

const S = Stream as any;
Object.assign(S, {
    isDestroyed,
    isDisturbed,
    isErrored,
    isReadable,
    isWritable,
    Readable,
    Writable,
    Duplex,
    Transform,
    PassThrough,
    duplexPair,
    pipeline,
    addAbortSignal,
    finished: eos,
    destroy: destroyer,
    compose,
    setDefaultHighWaterMark,
    getDefaultHighWaterMark
});
Object.defineProperty(S, "promises", {
    configurable: true,
    enumerable: true,
    get: () => promises
});
Object.assign(S, {
    Stream,
    _isArrayBufferView: isArrayBufferView,
    _isUint8Array: isUint8Array,
    _uint8ArrayToBuffer: uint8ArrayToBuffer
});

// typed as Node's for the importers of this file
type Module = typeof NodeStream;
const Exported = Stream as unknown as Module;
const ExportedReadable = Readable as unknown as Module["Readable"];
const ExportedWritable = Writable as unknown as Module["Writable"];
const ExportedDuplex = Duplex as unknown as Module["Duplex"];
const ExportedTransform = Transform as unknown as Module["Transform"];
const ExportedPassThrough = PassThrough as unknown as Module["PassThrough"];

export {
    Exported as Stream,
    Exported as default,
    Exported as "module.exports",
    ExportedReadable as Readable,
    ExportedWritable as Writable,
    ExportedDuplex as Duplex,
    ExportedTransform as Transform,
    ExportedPassThrough as PassThrough,
    duplexPair,
    pipeline,
    eos as finished,
    destroyer as destroy,
    addAbortSignal,
    compose,
    isDestroyed,
    isDisturbed,
    isErrored,
    isReadable,
    isWritable,
    getDefaultHighWaterMark,
    setDefaultHighWaterMark,
    promises
};
