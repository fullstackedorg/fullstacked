// stream.duplexPair (lib/internal/streams/duplexpair.js): two Duplexes, what
// is written to one is read from the other.

import { Duplex } from "./duplex.ts";
import { tick } from "./utils.ts";

const kCallback = Symbol("kCallback");
const kOtherSide = Symbol("kOtherSide");

function DuplexSide(this: any, options?: any) {
    (Duplex as any).call(this, options);
    this[kCallback] = null;
    this[kOtherSide] = null;
}
Object.setPrototypeOf(DuplexSide.prototype, Duplex.prototype);
Object.setPrototypeOf(DuplexSide, Duplex);

const proto = DuplexSide.prototype;

proto._read = function (this: any) {
    const callback = this[kCallback];
    if (callback) {
        this[kCallback] = null;
        callback();
    }
};

proto._write = function (
    this: any,
    chunk: any,
    _encoding: string,
    callback: () => void
) {
    if (chunk.length === 0) {
        tick(callback);
    } else {
        this[kOtherSide].push(chunk);
        this[kOtherSide][kCallback] = callback;
    }
};

proto._final = function (this: any, callback: () => void) {
    this[kOtherSide].on("end", callback);
    this[kOtherSide].push(null);
};

proto._destroy = function (this: any, err: any, callback: (err?: any) => void) {
    const otherSide = this[kOtherSide];
    if (otherSide !== null && !otherSide.destroyed) {
        tick(() => {
            if (otherSide.destroyed) return;
            if (err) otherSide.destroy();
            else otherSide.push(null);
        });
    }
    callback(err);
};

export function duplexPair(options?: any) {
    const side0 = new (DuplexSide as any)(options);
    const side1 = new (DuplexSide as any)(options);
    side0[kOtherSide] = side1;
    side1[kOtherSide] = side0;
    return [side0, side1];
}
