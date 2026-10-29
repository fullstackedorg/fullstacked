// Node is the oracle: every case runs the same function on the lib module
// and on node:<module> and compares what comes out, values or errors.
// A case listed in known-failures.ts is a known difference of the current
// shim (improvements/shim/conformance.md): it still runs, as a todo, so the suite stays
// green and the list shows what each stage fixes.

import test from "node:test";
import assert from "node:assert";
import { KNOWN_FAILURES } from "./known-failures.ts";

export const LIB = new URL("../../core/internal/bundle/lib/", import.meta.url);

// what a call produced, comparable across implementations: bytes as hex,
// errors as their name and code (messages differ between implementations)
export type Outcome = { value: unknown } | { error: unknown };

export function normalize(value: unknown, seen = new Set()): unknown {
    if (ArrayBuffer.isView(value)) {
        return `<bytes ${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}>`;
    }
    if (value instanceof ArrayBuffer) {
        return `<arraybuffer ${Buffer.from(value).toString("hex")}>`;
    }
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") return `<function ${value.name}>`;
    if (typeof value === "symbol") return value.toString();
    if (value instanceof Error) return errorShape(value);
    if (value && typeof value === "object") {
        if (seen.has(value)) return "<circular>";
        seen.add(value);
        if (Array.isArray(value)) return value.map((v) => normalize(v, seen));
        if (value instanceof Map) {
            return {
                "<map>": [...value].map(([k, v]) => [
                    normalize(k, seen),
                    normalize(v, seen)
                ])
            };
        }
        if (value instanceof Set) {
            return { "<set>": [...value].map((v) => normalize(v, seen)) };
        }
        if (value instanceof Date) return `<date ${value.toISOString()}>`;
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, normalize(v, seen)])
        );
    }
    return value;
}

export function errorShape(e: unknown) {
    if (e instanceof Error || (e && typeof e === "object" && "name" in e)) {
        const error = e as Error & { code?: unknown };
        return { name: error.name, code: error.code ?? null };
    }
    return { thrown: normalize(e) };
}

// a promise that does not settle in time is an outcome too
const SETTLE_TIMEOUT_MS = 2000;

export async function outcome(fn: () => unknown): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        let value = fn();
        if (value instanceof Promise) {
            value = await Promise.race([
                value,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject({ neverSettled: SETTLE_TIMEOUT_MS }),
                        SETTLE_TIMEOUT_MS
                    );
                })
            ]);
        }
        return { value: normalize(value) };
    } catch (e) {
        return { error: errorShape(e) };
    } finally {
        clearTimeout(timer);
    }
}

// test() with the known failures of the module marked todo
export function check(
    module: string,
    name: string,
    fn: () => void | Promise<void>
) {
    const reason = KNOWN_FAILURES[module]?.[name];
    return test(name, reason ? { todo: reason } : {}, fn);
}

// every error shape in an outcome as just "thrown": for the modules whose
// error codes follow OpenSSL or the Node patch release (crypto), where
// what matters is that the shim throws when Node does
export function thrownOnly(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(thrownOnly);
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort().join();
        if (keys === "code,name" || keys === "thrown") return "<thrown>";
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, thrownOnly(v)])
        );
    }
    return value;
}

// `same(name, fn)` checks fn(shim) against fn(node); with
// `{ errors: "thrown" }`, errors compare by being thrown, not by code
export function sameFor<M>(
    module: string,
    shim: M,
    node: M,
    options: { errors?: "code" | "thrown" } = {}
) {
    const compared =
        options.errors === "thrown" ? thrownOnly : (v: unknown) => v;
    return (name: string, fn: (m: M) => unknown) =>
        check(module, name, async () => {
            const ours = await outcome(() => fn(shim));
            const theirs = await outcome(() => fn(node));
            assert.deepStrictEqual(compared(ours), compared(theirs));
        });
}

// event logs of async scenarios, settled after a few turns of the loop
export function settle(ms = 20) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
