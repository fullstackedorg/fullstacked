// Readable.from (lib/internal/streams/from.js): a Readable over an iterable,
// async iterable, string or Buffer.

import { Buffer } from "../buffer/index.ts";
import {
    ERR_INVALID_ARG_TYPE,
    ERR_STREAM_NULL_VALUES,
    aggregateTwoErrors,
    isReadableStream,
    tick,
    webIterable
} from "./utils.ts";

export function from(Readable: any, iterable: any, opts?: any) {
    if (typeof iterable === "string" || iterable instanceof Buffer) {
        return new Readable({
            objectMode: true,
            ...opts,
            read(this: any) {
                this.push(iterable);
                this.push(null);
            }
        });
    }

    // a web ReadableStream is async iterable in Node, not in JavaScriptCore
    if (isReadableStream(iterable)) iterable = webIterable(iterable);

    let isAsync: boolean;
    let iterator: any;
    if (iterable?.[Symbol.asyncIterator]) {
        isAsync = true;
        iterator = iterable[Symbol.asyncIterator]();
    } else if (iterable?.[Symbol.iterator]) {
        isAsync = false;
        iterator = iterable[Symbol.iterator]();
    } else {
        throw ERR_INVALID_ARG_TYPE("iterable", ["Iterable"], iterable);
    }

    const readable = new Readable({
        objectMode: true,
        highWaterMark: 1,
        ...opts
    });
    const originalDestroy = readable._destroy;
    // one pull loop at a time
    let reading = false;
    let isAsyncValues = false;

    readable._read = function () {
        if (!reading) {
            reading = true;
            if (isAsync) nextAsync();
            else if (isAsyncValues) nextSyncWithAsyncValues();
            else nextSyncWithSyncValues();
        }
    };

    readable._destroy = function (error: any, cb: (err?: any) => void) {
        originalDestroy.call(this, error, (destroyError: any) => {
            const combined = destroyError || error;
            close(combined).then(
                () => tick(cb, combined),
                (closeError) =>
                    tick(cb, aggregateTwoErrors(combined, closeError))
            );
        });
    };

    async function close(error: any) {
        const hadError = error !== undefined && error !== null;
        if (hadError && typeof iterator.throw === "function") {
            const { value, done } = await iterator.throw(error);
            await value;
            if (done) return;
        }
        if (typeof iterator.return === "function") {
            const { value } = await iterator.return();
            await value;
        }
    }

    function nextSyncWithSyncValues() {
        for (;;) {
            try {
                const { value, done } = iterator.next();
                if (done) {
                    readable.push(null);
                    return;
                }
                if (value && typeof value.then === "function") {
                    changeToAsyncValues(value);
                    return;
                }
                if (value === null) {
                    reading = false;
                    throw ERR_STREAM_NULL_VALUES();
                }
                if (readable.push(value)) continue;
                reading = false;
            } catch (err) {
                readable.destroy(err);
            }
            break;
        }
    }

    async function changeToAsyncValues(value: Promise<any>) {
        isAsyncValues = true;
        try {
            const res = await value;
            if (res === null) {
                reading = false;
                throw ERR_STREAM_NULL_VALUES();
            }
            if (readable.push(res)) {
                nextSyncWithAsyncValues();
                return;
            }
            reading = false;
        } catch (err) {
            readable.destroy(err);
        }
    }

    async function nextSyncWithAsyncValues() {
        for (;;) {
            try {
                const { value, done } = iterator.next();
                if (done) {
                    readable.push(null);
                    return;
                }
                const res =
                    value && typeof value.then === "function"
                        ? await value
                        : value;
                if (res === null) {
                    reading = false;
                    throw ERR_STREAM_NULL_VALUES();
                }
                if (readable.push(res)) continue;
                reading = false;
            } catch (err) {
                readable.destroy(err);
            }
            break;
        }
    }

    async function nextAsync() {
        for (;;) {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    readable.push(null);
                    return;
                }
                if (value === null) {
                    reading = false;
                    throw ERR_STREAM_NULL_VALUES();
                }
                if (readable.push(value)) continue;
                reading = false;
            } catch (err) {
                readable.destroy(err);
            }
            break;
        }
    }

    return readable;
}
