// Calls into the core's Zlib module (core/internal/zlib, improvements/shim/plan.md 5.3).
// Sync for Node's sync APIs and ssh2's handle, async for the callback forms
// and the streams so the work runs off the JS thread. The core reports
// failures as "<Class>|<code>|<errno>|<message>"; they are thrown back as
// Node's error, with `errno` when zlib or brotli gave one.

import { Zlib } from "../@types/index.ts";
import { Free } from "../@types/zlib.ts";

const PREFIX = "error from bridge: [";

function rebuild(e: any) {
    const message: string = e?.message;
    if (typeof message !== "string" || !message.startsWith(PREFIX)) return e;
    const [Class, code, errno, ...rest] = message
        .slice(PREFIX.length, -1)
        .split("|");
    if (rest.length === 0) return e;
    const error: Error & { code?: string; errno?: number } = new (
        Class === "TypeError"
            ? TypeError
            : Class === "RangeError"
              ? RangeError
              : Error
    )(rest.join("|"));
    if (errno) error.errno = Number(errno);
    if (code) error.code = code;
    return error;
}

export function call(fn: number, ...data: unknown[]): any {
    try {
        return globalThis.fullstacked.bridge({ mod: Zlib, fn, data }, true);
    } catch (e) {
        throw rebuild(e);
    }
}

export function callAsync(fn: number, ...data: unknown[]): Promise<any> {
    return globalThis.fullstacked
        .bridge({ mod: Zlib, fn, data })
        .catch((e: unknown) => {
            throw rebuild(e);
        });
}

// A stream dropped before it ends leaves its handle (and, decompressing, a
// goroutine) in the core until the context ends; the registry frees it
// earlier
let registry: FinalizationRegistry<number>;

export function track(owner: object, handle: number) {
    registry ??= new FinalizationRegistry((h) => {
        callAsync(Free, h).catch(() => {});
    });
    registry.register(owner, handle, owner);
}

export function untrack(owner: object) {
    registry?.unregister(owner);
}
