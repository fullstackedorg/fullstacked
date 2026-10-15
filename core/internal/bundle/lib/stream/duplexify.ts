// Duplex.from (lib/internal/streams/duplexify.js): a Duplex out of a stream,
// a web stream, an (async) iterable, an async generator function, a promise
// or a { readable, writable } pair.

import { Readable } from "./readable.ts";
import { Duplex, disableReadable, disableWritable } from "./duplex.ts";
import { destroyer } from "./destroy.ts";
import { eos } from "./finished.ts";
import { from } from "./from.ts";
import {
    newStreamDuplexFromReadableWritablePair,
    newStreamReadableFromReadableStream,
    newStreamWritableFromWritableStream
} from "./adapters.ts";
import {
    AbortError,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_RETURN_VALUE,
    isDuplexNodeStream,
    isIterable,
    isNodeStream,
    isReadable,
    isReadableNodeStream,
    isReadableStream,
    isWritable,
    isWritableNodeStream,
    isWritableStream,
    tick
} from "./utils.ts";

// a Duplex that honors readable: false and writable: false
function Duplexify(this: any, options?: any): any {
    (Duplex as any).call(this, options);
    if (options?.readable === false) disableReadable(this);
    if (options?.writable === false) disableWritable(this);
}
Object.setPrototypeOf(Duplexify.prototype, Duplex.prototype);
Object.setPrototypeOf(Duplexify, Duplex);

const isBlob = (value: any) =>
    typeof Blob !== "undefined" && value instanceof Blob;

export function duplexify(body: any, name: string): any {
    if (isDuplexNodeStream(body)) return body;
    if (isReadableNodeStream(body)) return _duplexify({ readable: body });
    if (isWritableNodeStream(body)) return _duplexify({ writable: body });
    if (isNodeStream(body)) {
        return _duplexify({ writable: false, readable: false });
    }
    if (isReadableStream(body)) {
        return _duplexify({
            readable: newStreamReadableFromReadableStream(body)
        });
    }
    if (isWritableStream(body)) {
        return _duplexify({
            writable: newStreamWritableFromWritableStream(body)
        });
    }

    if (typeof body === "function") {
        const { value, write, final, destroy } = fromAsyncGen(body);
        if (isDuplexNodeStream(value)) return value;
        if (isIterable(value)) {
            return from(Duplexify, value, {
                objectMode: true,
                write,
                final,
                destroy
            });
        }
        const then = value?.then;
        if (typeof then === "function") {
            let d: any;
            const promise = then.call(
                value,
                (val: any) => {
                    if (val != null) {
                        throw ERR_INVALID_RETURN_VALUE("nully", "body", val);
                    }
                },
                (err: any) => destroyer(d, err)
            );
            return (d = new (Duplexify as any)({
                objectMode: true,
                readable: false,
                write,
                final(cb: (err?: any) => void) {
                    final(async () => {
                        try {
                            await promise;
                            tick(cb, null);
                        } catch (err) {
                            tick(cb, err);
                        }
                    });
                },
                destroy
            }));
        }
        throw ERR_INVALID_RETURN_VALUE(
            "Iterable, AsyncIterable or AsyncFunction",
            name,
            value
        );
    }

    if (isBlob(body)) return duplexify(body.arrayBuffer(), name);

    if (isIterable(body)) {
        return from(Duplexify, body, { objectMode: true, writable: false });
    }

    if (isReadableStream(body?.readable) && isWritableStream(body?.writable)) {
        return newStreamDuplexFromReadableWritablePair(body);
    }

    if (
        typeof body?.writable === "object" ||
        typeof body?.readable === "object"
    ) {
        const readable = body?.readable
            ? isReadableNodeStream(body.readable)
                ? body.readable
                : duplexify(body.readable, name)
            : undefined;
        const writable = body?.writable
            ? isWritableNodeStream(body.writable)
                ? body.writable
                : duplexify(body.writable, name)
            : undefined;
        return _duplexify({ readable, writable });
    }

    const then = body?.then;
    if (typeof then === "function") {
        let d: any;
        then.call(
            body,
            (val: any) => {
                if (val != null) d.push(val);
                d.push(null);
            },
            (err: any) => destroyer(d, err)
        );
        return (d = new (Duplexify as any)({
            objectMode: true,
            writable: false,
            read() {}
        }));
    }

    throw ERR_INVALID_ARG_TYPE(
        name,
        [
            "Blob",
            "ReadableStream",
            "WritableStream",
            "Stream",
            "Iterable",
            "AsyncIterable",
            "Function",
            "{ readable, writable } pair",
            "Promise"
        ],
        body
    );
}

// the writes of the Duplex as the async iterable the function reads
function fromAsyncGen(fn: Function) {
    let { promise, resolve } = withResolvers();
    const ac = new AbortController();
    const signal = ac.signal;
    const value = fn(
        (async function* () {
            while (true) {
                const _promise = promise;
                promise = null;
                const { chunk, done, cb } = await _promise;
                tick(cb);
                if (done) return;
                if (signal.aborted) {
                    throw new AbortError(undefined, { cause: signal.reason });
                }
                ({ promise, resolve } = withResolvers());
                yield chunk;
            }
        })(),
        { signal }
    );

    return {
        value,
        write(chunk: any, _encoding: string, cb: () => void) {
            const _resolve = resolve;
            resolve = null;
            _resolve({ chunk, done: false, cb });
        },
        final(cb: () => void) {
            const _resolve = resolve;
            resolve = null;
            _resolve({ done: true, cb });
        },
        destroy(err: any, cb: (err?: any) => void) {
            ac.abort(err);
            if (resolve !== null) {
                const _resolve = resolve;
                resolve = null;
                _resolve({ done: true, cb() {} });
            }
            cb(err);
        }
    };
}

function withResolvers() {
    let resolve: (value: any) => void;
    const promise = new Promise<any>((res) => (resolve = res));
    return { promise, resolve };
}

function _duplexify(pair: { readable?: any; writable?: any }) {
    const r =
        pair.readable && typeof pair.readable.read !== "function"
            ? (Readable as any).wrap(pair.readable)
            : pair.readable;
    const w = pair.writable;

    let readable = !!isReadable(r);
    let writable = !!isWritable(w);

    let ondrain: (() => void) | null;
    let onfinish: (() => void) | null;
    let onreadable: (() => void) | null;
    let onclose: ((err?: any) => void) | null;
    let d: any;

    function onfinished(err?: any) {
        const cb = onclose;
        onclose = null;
        if (cb) cb(err);
        else if (err) d.destroy(err);
    }

    d = new (Duplexify as any)({
        readableObjectMode: !!r?.readableObjectMode,
        writableObjectMode: !!w?.writableObjectMode,
        readable,
        writable
    });

    if (writable) {
        eos(w, (err) => {
            writable = false;
            if (err) destroyer(r, err);
            onfinished(err);
        });
        d._write = function (
            chunk: any,
            encoding: string,
            callback: () => void
        ) {
            if (w.write(chunk, encoding)) callback();
            else ondrain = callback;
        };
        d._final = function (callback: () => void) {
            w.end();
            onfinish = callback;
        };
        w.on("drain", function () {
            if (ondrain) {
                const cb = ondrain;
                ondrain = null;
                cb();
            }
        });
        w.on("finish", function () {
            if (onfinish) {
                const cb = onfinish;
                onfinish = null;
                cb();
            }
        });
    }

    if (readable) {
        eos(r, (err) => {
            readable = false;
            if (err) destroyer(w, err);
            onfinished(err);
        });
        r.on("readable", function () {
            if (onreadable) {
                const cb = onreadable;
                onreadable = null;
                cb();
            }
        });
        r.on("end", function () {
            d.push(null);
        });
        d._read = function () {
            while (true) {
                const buf = r.read();
                if (buf === null) {
                    onreadable = d._read;
                    return;
                }
                if (!d.push(buf)) return;
            }
        };
    }

    d._destroy = function (err: any, callback: (err?: any) => void) {
        if (!err && onclose !== null) err = new AbortError();
        onreadable = null;
        ondrain = null;
        onfinish = null;
        if (onclose === null) {
            callback(err);
        } else {
            onclose = callback;
            destroyer(w, err);
            destroyer(r, err);
        }
    };

    return d;
}
