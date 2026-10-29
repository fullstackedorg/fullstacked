// Readable/Writable/Duplex .fromWeb and .toWeb over the engine's web streams
// (lib/internal/webstreams/adapters.js).

import { Buffer } from "../buffer/index.ts";
import { Readable } from "./readable.ts";
import { Writable } from "./writable.ts";
import { Duplex } from "./duplex.ts";
import { destroyer as destroy } from "./destroy.ts";
import { eos } from "./finished.ts";
import {
    AbortError,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_STREAM_PREMATURE_CLOSE,
    isDestroyed,
    isReadable,
    isReadableStream,
    isWritable,
    isWritableEnded,
    isWritableStream,
    tick,
    validateBoolean,
    validateObject
} from "./utils.ts";

const isEncoding = (Buffer as any).isEncoding as (e: unknown) => boolean;

function handleKnownInternalErrors(cause: any) {
    if (cause?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        return new AbortError(undefined, { cause });
    }
    return cause;
}

function deferred() {
    let resolve: (value?: any) => void;
    let reject: (reason?: any) => void;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// a string chunk of a byte stream as bytes for the web stream
function toWebChunk(
    chunk: any,
    encoding: string,
    decodeStrings: boolean,
    objectMode: boolean
) {
    if (typeof chunk === "string" && decodeStrings && !objectMode) {
        const bytes = Buffer.from(chunk, encoding as BufferEncoding);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return chunk;
}

// the write side shared by Writable.fromWeb and Duplex.fromWeb
function webWriter(
    writer: WritableStreamDefaultWriter,
    stream: () => any,
    decodeStrings: boolean,
    objectMode: boolean
) {
    function settle(callback: (err?: any) => void, sync?: boolean) {
        return (error?: any) => {
            try {
                callback(error);
            } catch (error) {
                if (sync) destroy(stream(), error);
                else tick(destroy, stream(), error);
            }
        };
    }
    return {
        writev(chunks: { chunk: any }[], callback: (err?: any) => void) {
            const done = settle(callback);
            writer.ready.then(
                () =>
                    Promise.all(
                        chunks.map((data) => writer.write(data.chunk))
                    ).then(() => done(), done),
                done
            );
        },
        write(chunk: any, encoding: string, callback: (err?: any) => void) {
            chunk = toWebChunk(chunk, encoding, decodeStrings, objectMode);
            const done = settle(callback, true);
            writer.ready.then(
                () => writer.write(chunk).then(() => done(), done),
                done
            );
        }
    };
}

export function newWritableStreamFromStreamWritable(streamWritable: any) {
    if (
        typeof streamWritable?.write !== "function" ||
        typeof streamWritable?.on !== "function"
    ) {
        throw ERR_INVALID_ARG_TYPE(
            "streamWritable",
            "stream.Writable",
            streamWritable
        );
    }
    if (isDestroyed(streamWritable) || !isWritable(streamWritable)) {
        const writable = new WritableStream();
        writable.close();
        return writable;
    }

    const highWaterMark = streamWritable.writableHighWaterMark;
    const strategy = streamWritable.writableObjectMode
        ? new CountQueuingStrategy({ highWaterMark })
        : { highWaterMark };

    let controller: WritableStreamDefaultController;
    let backpressurePromise: ReturnType<typeof deferred> | undefined;
    let closed: ReturnType<typeof deferred> | undefined;

    const cleanup = eos(streamWritable, (error) => {
        error = handleKnownInternalErrors(error);
        cleanup();
        streamWritable.on("error", () => {});
        if (error != null) {
            backpressurePromise?.reject(error);
            if (closed !== undefined) {
                closed.reject(error);
                closed = undefined;
            }
            controller.error(error);
            controller = undefined;
            return;
        }
        if (closed !== undefined) {
            closed.resolve();
            closed = undefined;
            return;
        }
        controller.error(new AbortError());
        controller = undefined;
    });

    streamWritable.on("drain", () => backpressurePromise?.resolve());

    return new WritableStream(
        {
            start(c) {
                controller = c;
            },
            write(chunk) {
                if (
                    !streamWritable.writableObjectMode &&
                    chunk instanceof ArrayBuffer
                ) {
                    chunk = new Uint8Array(chunk);
                }
                if (
                    streamWritable.writableNeedDrain ||
                    !streamWritable.write(chunk)
                ) {
                    backpressurePromise = deferred();
                    return backpressurePromise.promise.finally(() => {
                        backpressurePromise = undefined;
                    }) as Promise<void>;
                }
            },
            abort(reason) {
                destroy(streamWritable, reason);
            },
            close() {
                if (closed === undefined && !isWritableEnded(streamWritable)) {
                    closed = deferred();
                    streamWritable.end();
                    return closed.promise as Promise<void>;
                }
                controller = undefined;
                return Promise.resolve();
            }
        },
        strategy
    );
}

export function newStreamWritableFromWritableStream(
    writableStream: any,
    options: any = {}
) {
    if (!isWritableStream(writableStream)) {
        throw ERR_INVALID_ARG_TYPE(
            "writableStream",
            "WritableStream",
            writableStream
        );
    }
    validateObject(options, "options");
    const {
        highWaterMark,
        decodeStrings = true,
        objectMode = false,
        signal
    } = options;
    validateBoolean(objectMode, "options.objectMode");
    validateBoolean(decodeStrings, "options.decodeStrings");

    const writer = writableStream.getWriter();
    let closed = false;

    const writable = new (Writable as any)({
        highWaterMark,
        objectMode,
        decodeStrings,
        signal,
        ...webWriter(writer, () => writable, decodeStrings, objectMode),
        destroy(error: any, callback: (err?: any) => void) {
            const done = () => callback(error);
            if (!closed) {
                (error != null ? writer.abort(error) : writer.close()).then(
                    done,
                    done
                );
                return;
            }
            done();
        },
        final(callback: (err?: any) => void) {
            const done = (error?: any) => {
                try {
                    callback(error);
                } catch (error) {
                    tick(destroy, writable, error);
                }
            };
            if (!closed) writer.close().then(() => done(), done);
        }
    });

    writer.closed.then(
        () => {
            closed = true;
            if (!isWritableEnded(writable)) {
                destroy(writable, ERR_STREAM_PREMATURE_CLOSE());
            }
        },
        (error: any) => {
            closed = true;
            destroy(writable, error);
        }
    );
    return writable;
}

export function newReadableStreamFromStreamReadable(
    streamReadable: any,
    options: any = {}
) {
    if (typeof streamReadable?._readableState !== "object") {
        throw ERR_INVALID_ARG_TYPE(
            "streamReadable",
            "stream.Readable",
            streamReadable
        );
    }
    validateObject(options, "options");
    const isBYOB = options.type === "bytes";

    if (isDestroyed(streamReadable) || !isReadable(streamReadable)) {
        const readable = new ReadableStream();
        readable.cancel();
        return readable;
    }

    const objectMode = streamReadable.readableObjectMode;
    const highWaterMark = streamReadable.readableHighWaterMark;
    const strategy = isBYOB
        ? { highWaterMark }
        : options.strategy ||
          (objectMode
              ? new CountQueuingStrategy({ highWaterMark })
              : new ByteLengthQueuingStrategy({ highWaterMark }));

    let controller: any;
    let wasCanceled = false;

    function onData(chunk: any) {
        if (Buffer.isBuffer(chunk) && !objectMode)
            chunk = new Uint8Array(chunk);
        controller.enqueue(chunk);
        if (controller.desiredSize <= 0) streamReadable.pause();
    }

    streamReadable.pause();

    const cleanup = eos(streamReadable, (error) => {
        error = handleKnownInternalErrors(error);
        cleanup();
        streamReadable.on("error", () => {});
        if (error) return controller.error(error);
        if (wasCanceled) return;
        controller.close();
    });

    streamReadable.on("data", onData);

    return new ReadableStream(
        {
            type: isBYOB ? "bytes" : undefined,
            start(c: any) {
                controller = c;
                if (isBYOB) {
                    streamReadable.once("end", () => {
                        controller.close();
                        controller.byobRequest?.respond(0);
                        wasCanceled = true;
                    });
                }
            },
            pull() {
                streamReadable.resume();
            },
            cancel(reason: any) {
                wasCanceled = true;
                destroy(streamReadable, reason);
            }
        } as any,
        strategy
    );
}

// the read side shared by Readable.fromWeb and Duplex.fromWeb
function readFrom(reader: ReadableStreamDefaultReader, stream: () => any) {
    return function read() {
        reader.read().then(
            (chunk) => {
                if (chunk.done) stream().push(null);
                else stream().push(chunk.value);
            },
            (error) => destroy(stream(), error)
        );
    };
}

export function newStreamReadableFromReadableStream(
    readableStream: any,
    options: any = {}
) {
    if (!isReadableStream(readableStream)) {
        throw ERR_INVALID_ARG_TYPE(
            "readableStream",
            "ReadableStream",
            readableStream
        );
    }
    validateObject(options, "options");
    const { highWaterMark, encoding, objectMode = false, signal } = options;
    if (encoding !== undefined && !isEncoding(encoding)) {
        throw ERR_INVALID_ARG_VALUE("options.encoding", encoding);
    }
    validateBoolean(objectMode, "options.objectMode");

    const reader = readableStream.getReader();
    let closed = false;

    const readable = new (Readable as any)({
        objectMode,
        highWaterMark,
        encoding,
        signal,
        read: readFrom(reader, () => readable),
        destroy(error: any, callback: (err?: any) => void) {
            const done = () => callback(error);
            if (!closed) {
                reader.cancel(error).then(done, done);
                return;
            }
            done();
        }
    });

    reader.closed.then(
        () => {
            closed = true;
        },
        (error: any) => {
            closed = true;
            destroy(readable, error);
        }
    );
    return readable;
}

export function newReadableWritablePairFromDuplex(
    duplex: any,
    options: any = {}
) {
    if (
        typeof duplex?._writableState !== "object" ||
        typeof duplex?._readableState !== "object"
    ) {
        throw ERR_INVALID_ARG_TYPE("duplex", "stream.Duplex", duplex);
    }
    validateObject(options, "options");
    const type = options.readableType ?? options.type;

    if (isDestroyed(duplex)) {
        const writable = new WritableStream();
        const readable = new ReadableStream({ type } as any);
        writable.close();
        readable.cancel();
        return { readable, writable };
    }

    const writable = isWritable(duplex)
        ? newWritableStreamFromStreamWritable(duplex)
        : new WritableStream();
    if (!isWritable(duplex)) writable.close();

    const readable = isReadable(duplex)
        ? newReadableStreamFromStreamReadable(duplex, { type })
        : new ReadableStream({ type } as any);
    if (!isReadable(duplex)) readable.cancel();

    return { writable, readable };
}

export function newStreamDuplexFromReadableWritablePair(
    pair: any = {},
    options: any = {}
) {
    validateObject(pair, "pair");
    const { readable: readableStream, writable: writableStream } = pair;
    if (!isReadableStream(readableStream)) {
        throw ERR_INVALID_ARG_TYPE(
            "pair.readable",
            "ReadableStream",
            readableStream
        );
    }
    if (!isWritableStream(writableStream)) {
        throw ERR_INVALID_ARG_TYPE(
            "pair.writable",
            "WritableStream",
            writableStream
        );
    }
    validateObject(options, "options");
    const {
        allowHalfOpen = false,
        objectMode = false,
        encoding,
        decodeStrings = true,
        highWaterMark,
        signal
    } = options;
    validateBoolean(objectMode, "options.objectMode");
    if (encoding !== undefined && !isEncoding(encoding)) {
        throw ERR_INVALID_ARG_VALUE("options.encoding", encoding);
    }

    const writer = writableStream.getWriter();
    const reader = readableStream.getReader();
    let writableClosed = false;
    let readableClosed = false;

    const duplex = new (Duplex as any)({
        allowHalfOpen,
        highWaterMark,
        objectMode,
        encoding,
        decodeStrings,
        signal,
        ...webWriter(writer, () => duplex, decodeStrings, objectMode),
        final(callback: (err?: any) => void) {
            const done = (error?: any) => {
                try {
                    callback(error);
                } catch (error) {
                    tick(destroy, duplex, error);
                }
            };
            if (!writableClosed) writer.close().then(() => done(), done);
        },
        read: readFrom(reader, () => duplex),
        destroy(error: any, callback: (err?: any) => void) {
            const done = () => callback(error);
            if (!writableClosed || !readableClosed) {
                Promise.all([
                    !writableClosed && writer.abort(error),
                    !readableClosed && reader.cancel(error)
                ]).then(done, done);
                return;
            }
            done();
        }
    });

    writer.closed.then(
        () => {
            writableClosed = true;
            if (!isWritableEnded(duplex)) {
                destroy(duplex, ERR_STREAM_PREMATURE_CLOSE());
            }
        },
        (error: any) => {
            writableClosed = readableClosed = true;
            destroy(duplex, error);
        }
    );
    reader.closed.then(
        () => {
            readableClosed = true;
        },
        (error: any) => {
            writableClosed = readableClosed = true;
            destroy(duplex, error);
        }
    );
    return duplex;
}
