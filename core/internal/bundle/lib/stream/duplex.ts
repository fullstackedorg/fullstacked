// stream.Duplex (lib/internal/streams/duplex.js): a Readable with the
// Writable methods and state copied on.

import {
    Readable,
    ReadableState,
    onConstructed as readableConstructed
} from "./readable.ts";
import { Writable, WritableState, onConstructed } from "./writable.ts";
import { Stream } from "./legacy.ts";
import { addAbortSignal } from "./addAbortSignal.ts";
import { construct } from "./destroy.ts";

export function Duplex(this: any, options?: any): any {
    if (!(this instanceof (Duplex as any))) return new (Duplex as any)(options);
    this._readableState = new ReadableState(options, this, true);
    this._writableState = new WritableState(options, this, true);
    if (options) {
        this.allowHalfOpen = options.allowHalfOpen !== false;
        if (options.readable === false) disableReadable(this);
        if (options.writable === false) disableWritable(this);
        if (typeof options.read === "function") this._read = options.read;
        if (typeof options.write === "function") this._write = options.write;
        if (typeof options.writev === "function") this._writev = options.writev;
        if (typeof options.destroy === "function") {
            this._destroy = options.destroy;
        }
        if (typeof options.final === "function") this._final = options.final;
        if (typeof options.construct === "function") {
            this._construct = options.construct;
        }
        if (options.signal) addAbortSignal(options.signal, this);
    } else {
        this.allowHalfOpen = true;
    }
    (Stream as any).call(this, options);
    if (this._construct != null) {
        construct(this, () => {
            readableConstructed(this);
            onConstructed(this);
        });
    }
}

export function disableReadable(stream: any) {
    const r = stream._readableState;
    r.readable = false;
    r.ended = r.endEmitted = true;
}

export function disableWritable(stream: any) {
    const w = stream._writableState;
    w.writable = false;
    w.ending = w.ended = w.finished = true;
}

Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
Object.setPrototypeOf(Duplex, Readable);

const proto = Duplex.prototype;
const writableProto = Writable.prototype;

for (const method of Object.keys(writableProto)) {
    proto[method] ||= writableProto[method];
}
proto.destroy = writableProto.destroy;

for (const name of [
    "writable",
    "writableHighWaterMark",
    "writableObjectMode",
    "writableBuffer",
    "writableLength",
    "writableFinished",
    "writableCorked",
    "writableEnded",
    "writableNeedDrain"
]) {
    Object.defineProperty(
        proto,
        name,
        Object.getOwnPropertyDescriptor(writableProto, name)
    );
}

Object.defineProperty(proto, "destroyed", {
    get(this: any) {
        const r = this._readableState;
        const w = this._writableState;
        return r !== undefined && w !== undefined && r.destroyed && w.destroyed;
    },
    set(this: any, value: boolean) {
        const r = this._readableState;
        const w = this._writableState;
        if (r && w) {
            r.destroyed = value;
            w.destroyed = value;
        }
    },
    configurable: true
});
