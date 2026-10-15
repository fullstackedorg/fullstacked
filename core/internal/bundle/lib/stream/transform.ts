// stream.Transform (lib/internal/streams/transform.js): what _transform()
// calls back is pushed to the readable side; the write callback waits while
// the readable side is above its highWaterMark.
//
// Node creates a closure per chunk for the _transform() callback; here it is
// bound once per stream, with the write in progress kept on the stream (a
// Writable calls _write() one chunk at a time).

import { Duplex } from "./duplex.ts";
import { ERR_METHOD_NOT_IMPLEMENTED, getHighWaterMark, tick } from "./utils.ts";

const kCallback = Symbol("kCallback");
const kOnTransform = Symbol("kOnTransform");
const kWriteCallback = Symbol("kWriteCallback");
const kLength = Symbol("kLength");

export function Transform(this: any, options?: any): any {
    if (!(this instanceof (Transform as any)))
        return new (Transform as any)(options);

    // a readable highWaterMark of 0 makes the writable one 0 too
    const readableHighWaterMark = options
        ? getHighWaterMark(false, options, "readableHighWaterMark", true)
        : null;
    if (readableHighWaterMark === 0) {
        options = {
            ...options,
            highWaterMark: null,
            readableHighWaterMark,
            writableHighWaterMark: options.writableHighWaterMark || 0
        };
    }

    (Duplex as any).call(this, options);

    // 'data' as soon as _transform() calls back
    this._readableState.sync = false;

    this[kCallback] = null;
    this[kWriteCallback] = null;
    this[kLength] = 0;
    this[kOnTransform] = (err: any, val: any) => onTransform(this, err, val);

    if (options) {
        if (typeof options.transform === "function") {
            this._transform = options.transform;
        }
        if (typeof options.flush === "function") this._flush = options.flush;
    }

    this.on("prefinish", prefinish);
}

Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
Object.setPrototypeOf(Transform, Duplex);

function final(this: any, cb?: (err?: any) => void) {
    if (typeof this._flush === "function" && !this.destroyed) {
        this._flush((er: any, data: any) => {
            if (er) {
                if (cb) cb(er);
                else this.destroy(er);
                return;
            }
            if (data != null) this.push(data);
            this.push(null);
            if (cb) cb();
        });
    } else {
        this.push(null);
        if (cb) cb();
    }
}

function prefinish(this: any) {
    if (this._final !== final) final.call(this);
}

const proto = Transform.prototype;

proto._final = final;

proto._transform = function () {
    throw ERR_METHOD_NOT_IMPLEMENTED("_transform()");
};

proto._write = function (
    this: any,
    chunk: any,
    encoding: string,
    callback: (err?: any) => void
) {
    this[kWriteCallback] = callback;
    this[kLength] = this._readableState.length;
    this._transform(chunk, encoding, this[kOnTransform]);
};

function onTransform(stream: any, err: any, val: any) {
    const callback = stream[kWriteCallback];
    if (err) {
        callback(err);
        return;
    }
    const rState = stream._readableState;
    if (val != null) stream.push(val);
    if (rState.ended) {
        tick(callback);
    } else if (
        stream._writableState.ended ||
        stream[kLength] === rState.length ||
        rState.length < rState.highWaterMark
    ) {
        callback();
    } else {
        // the readable side is full: the next _read() calls back
        stream[kCallback] = callback;
    }
}

proto._read = function (this: any) {
    const callback = this[kCallback];
    if (callback) {
        this[kCallback] = null;
        callback();
    }
};
