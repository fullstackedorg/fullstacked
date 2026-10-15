// stream.compose (lib/internal/streams/compose.js): a pipeline as one
// Duplex, written at the head and read at the tail.

import { Duplex } from "./duplex.ts";
import { pipeline } from "./pipeline.ts";
import { duplexify } from "./duplexify.ts";
import { destroyer } from "./destroy.ts";
import { eos } from "./finished.ts";
import {
    AbortError,
    ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS,
    isNodeStream,
    isReadable,
    isReadableStream,
    isTransformStream,
    isWebStream,
    isWritable,
    isWritableStream
} from "./utils.ts";

export function compose(...streams: any[]) {
    if (streams.length === 0) throw ERR_MISSING_ARGS("streams");
    if (streams.length === 1) return duplexify(streams[0], "body");

    const orgStreams = streams.slice();
    if (typeof streams[0] === "function") {
        streams[0] = duplexify(streams[0], "body");
    }
    const last = streams.length - 1;
    if (typeof streams[last] === "function") {
        streams[last] = duplexify(streams[last], "body");
    }

    for (let n = 0; n < streams.length; ++n) {
        if (!isNodeStream(streams[n]) && !isWebStream(streams[n])) continue;
        if (
            n < streams.length - 1 &&
            !(
                isReadable(streams[n]) ||
                isReadableStream(streams[n]) ||
                isTransformStream(streams[n])
            )
        ) {
            throw ERR_INVALID_ARG_VALUE(
                `streams[${n}]`,
                orgStreams[n],
                "must be readable"
            );
        }
        if (
            n > 0 &&
            !(
                isWritable(streams[n]) ||
                isWritableStream(streams[n]) ||
                isTransformStream(streams[n])
            )
        ) {
            throw ERR_INVALID_ARG_VALUE(
                `streams[${n}]`,
                orgStreams[n],
                "must be writable"
            );
        }
    }

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
        else if (!readable && !writable) d.destroy();
    }

    const head = streams[0];
    const tail = pipeline(streams, onfinished);

    const writable = !!(
        isWritable(head) ||
        isWritableStream(head) ||
        isTransformStream(head)
    );
    const readable = !!(
        isReadable(tail) ||
        isReadableStream(tail) ||
        isTransformStream(tail)
    );

    d = new (Duplex as any)({
        writableObjectMode: !!head?.writableObjectMode,
        readableObjectMode: !!tail?.readableObjectMode,
        writable,
        readable
    });

    if (writable) {
        if (isNodeStream(head)) {
            d._write = function (
                chunk: any,
                encoding: string,
                callback: () => void
            ) {
                if (head.write(chunk, encoding)) callback();
                else ondrain = callback;
            };
            d._final = function (callback: () => void) {
                head.end();
                onfinish = callback;
            };
            head.on("drain", function () {
                if (ondrain) {
                    const cb = ondrain;
                    ondrain = null;
                    cb();
                }
            });
        } else if (isWebStream(head)) {
            const writer = (
                isTransformStream(head) ? head.writable : head
            ).getWriter();
            d._write = async function (
                chunk: any,
                _encoding: string,
                callback: (err?: any) => void
            ) {
                try {
                    await writer.ready;
                    writer.write(chunk).catch(() => {});
                    callback();
                } catch (err) {
                    callback(err);
                }
            };
            d._final = async function (callback: (err?: any) => void) {
                try {
                    await writer.ready;
                    writer.close().catch(() => {});
                    onfinish = callback;
                } catch (err) {
                    callback(err);
                }
            };
        }

        const toRead = isTransformStream(tail) ? tail.readable : tail;
        eos(toRead, () => {
            if (onfinish) {
                const cb = onfinish;
                onfinish = null;
                cb();
            }
        });
    }

    if (readable) {
        if (isNodeStream(tail)) {
            tail.on("readable", function () {
                if (onreadable) {
                    const cb = onreadable;
                    onreadable = null;
                    cb();
                }
            });
            tail.on("end", function () {
                d.push(null);
            });
            d._read = function () {
                while (true) {
                    const buf = tail.read();
                    if (buf === null) {
                        onreadable = d._read;
                        return;
                    }
                    if (!d.push(buf)) return;
                }
            };
        } else if (isWebStream(tail)) {
            const reader = (
                isTransformStream(tail) ? tail.readable : tail
            ).getReader();
            d._read = async function () {
                while (true) {
                    try {
                        const { value, done } = await reader.read();
                        if (!d.push(value)) return;
                        if (done) {
                            d.push(null);
                            return;
                        }
                    } catch {
                        return;
                    }
                }
            };
        }
    }

    d._destroy = function (err: any, callback: (err?: any) => void) {
        if (!err && onclose !== null) err = new AbortError();
        onreadable = null;
        ondrain = null;
        onfinish = null;
        if (isNodeStream(tail)) destroyer(tail, err);
        if (onclose === null) callback(err);
        else onclose = callback;
    };

    return d;
}
