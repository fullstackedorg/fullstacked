// Calls into the core's Crypto module (core/internal/crypto, improvements/shim/plan.md
// 5.2). Sync for Node's sync APIs, async for the callback and promise forms
// so the work runs off the JS thread. The core reports failures as
// "<Class>|<code>|<message>"; they are thrown back as the Node error.

import { Crypto } from "../@types/index.ts";
import { Free } from "../@types/crypto.ts";

const PREFIX = "error from bridge: [";

function rebuild(e: any) {
    const message: string = e?.message;
    if (typeof message !== "string" || !message.startsWith(PREFIX)) return e;
    const body = message.slice(PREFIX.length, -1);
    const i = body.indexOf("|");
    const j = body.indexOf("|", i + 1);
    if (i < 0 || j < 0) return e;
    const Class = body.slice(0, i);
    const error: Error & { code?: string } = new (
        Class === "TypeError"
            ? TypeError
            : Class === "RangeError"
              ? RangeError
              : Error
    )(body.slice(j + 1));
    const code = body.slice(i + 1, j);
    if (code) error.code = code;
    return error;
}

export function call(fn: number, ...data: unknown[]): any {
    try {
        return globalThis.fullstacked.bridge({ mod: Crypto, fn, data }, true);
    } catch (e) {
        throw rebuild(e);
    }
}

export function callAsync(fn: number, ...data: unknown[]): Promise<any> {
    return globalThis.fullstacked
        .bridge({ mod: Crypto, fn, data })
        .catch((e: unknown) => {
            throw rebuild(e);
        });
}

// A hash or cipher dropped before its finishing call leaves its handle in
// the core until the context ends; the registry frees it earlier
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

// settles a callback from an async core call; what the callback throws
// surfaces as an uncaught exception, not as a rejection
export function settle(
    promise: Promise<any>,
    callback: (error: Error, value?: any) => void,
    map: (value: any) => any = (v) => v
) {
    promise
        .then(
            (value) => callback(null, map(value)),
            (e) => callback(e)
        )
        .catch((e) =>
            setTimeout(() => {
                throw e;
            })
        );
}
