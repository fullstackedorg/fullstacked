// stream.PassThrough (lib/internal/streams/passthrough.js)

import { Transform } from "./transform.ts";

export function PassThrough(this: any, options?: any): any {
    if (!(this instanceof (PassThrough as any))) {
        return new (PassThrough as any)(options);
    }
    (Transform as any).call(this, options);
}

Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);
Object.setPrototypeOf(PassThrough, Transform);

PassThrough.prototype._transform = function (
    chunk: any,
    _encoding: string,
    cb: (err?: any, data?: any) => void
) {
    cb(null, chunk);
};
