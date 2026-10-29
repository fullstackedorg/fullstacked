// The Readable operators (lib/internal/streams/operators.js): map, filter,
// flatMap, drop and take return a Readable (index.ts wraps them with
// Readable.from), forEach, toArray, some, every, find and reduce a promise.

import { finished } from "./finished.ts";
import {
    AbortError,
    ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE,
    validateAbortSignal,
    validateFunction,
    validateObject
} from "./utils.ts";
import { validateInteger } from "../buffer/errors.ts";

const kEmpty = Symbol("kEmpty");
const kEof = Symbol("kEof");

type Options = {
    signal?: AbortSignal;
    concurrency?: number;
    highWaterMark?: number;
};
type Fn = (value: any, options: { signal: AbortSignal }) => any;

function validateOptions(options: any) {
    if (options != null) validateObject(options, "options");
    if (options?.signal != null) {
        validateAbortSignal(options.signal, "options.signal");
    }
}

function anySignal(signal?: AbortSignal): AbortSignal {
    const AS = AbortSignal as any;
    if (typeof AS.any === "function") return AS.any(signal ? [signal] : []);
    // engines without AbortSignal.any
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    else
        signal?.addEventListener("abort", () =>
            controller.abort(signal.reason)
        );
    return controller.signal;
}

export function map(this: any, fn: Fn, options?: Options) {
    validateFunction(fn, "fn");
    validateOptions(options);

    let concurrency = 1;
    if (options?.concurrency != null) {
        concurrency = Math.floor(options.concurrency);
    }
    let highWaterMark = concurrency - 1;
    if (options?.highWaterMark != null) {
        highWaterMark = Math.floor(options.highWaterMark);
    }
    validateInteger(concurrency, "options.concurrency", 1);
    validateInteger(highWaterMark, "options.highWaterMark", 0);
    highWaterMark += concurrency;

    return async function* map(this: any) {
        const signal = anySignal(options?.signal);
        const stream = this;
        const queue: any[] = [];
        const signalOpt = { signal };

        let next: (() => void) | null;
        let resume: (() => void) | null;
        let done = false;
        let cnt = 0;

        function onCatch() {
            done = true;
            afterItemProcessed();
        }

        function afterItemProcessed() {
            cnt -= 1;
            maybeResume();
        }

        function maybeResume() {
            if (
                resume &&
                !done &&
                cnt < concurrency &&
                queue.length < highWaterMark
            ) {
                resume();
                resume = null;
            }
        }

        async function pump() {
            try {
                for await (let val of stream) {
                    if (done) return;
                    if (signal.aborted) throw new AbortError();
                    try {
                        val = fn(val, signalOpt);
                        if (val === kEmpty) continue;
                        val = Promise.resolve(val);
                    } catch (err) {
                        val = Promise.reject(err);
                    }
                    cnt += 1;
                    val.then(afterItemProcessed, onCatch);
                    queue.push(val);
                    if (next) {
                        next();
                        next = null;
                    }
                    if (
                        !done &&
                        (queue.length >= highWaterMark || cnt >= concurrency)
                    ) {
                        await new Promise<void>((resolve) => {
                            resume = resolve;
                        });
                    }
                }
                queue.push(kEof);
            } catch (err) {
                const val = Promise.reject(err);
                val.then(afterItemProcessed, onCatch);
                queue.push(val);
            } finally {
                done = true;
                if (next) {
                    next();
                    next = null;
                }
            }
        }

        pump();

        try {
            while (true) {
                while (queue.length > 0) {
                    const val = await queue[0];
                    if (val === kEof) return;
                    if (signal.aborted) throw new AbortError();
                    if (val !== kEmpty) yield val;
                    queue.shift();
                    maybeResume();
                }
                await new Promise<void>((resolve) => {
                    next = resolve;
                });
            }
        } finally {
            done = true;
            if (resume) {
                resume();
                resume = null;
            }
        }
    }.call(this);
}

export async function some(this: any, fn: Fn, options?: Options) {
    for await (const _ of filter.call(this, fn, options)) return true;
    return false;
}

export async function every(this: any, fn: Fn, options?: Options) {
    validateFunction(fn, "fn");
    return !(await some.call(
        this,
        async (...args: [any, any]) => !(await fn(...args)),
        options
    ));
}

export async function find(this: any, fn: Fn, options?: Options) {
    for await (const result of filter.call(this, fn, options)) return result;
    return undefined;
}

export async function forEach(this: any, fn: Fn, options?: Options) {
    validateFunction(fn, "fn");
    async function forEachFn(value: any, options: any) {
        await fn(value, options);
        return kEmpty;
    }
    for await (const _ of map.call(this, forEachFn, options));
}

export function filter(this: any, fn: Fn, options?: Options) {
    validateFunction(fn, "fn");
    async function filterFn(value: any, options: any) {
        if (await fn(value, options)) return value;
        return kEmpty;
    }
    return map.call(this, filterFn, options);
}

export async function reduce(
    this: any,
    reducer: (acc: any, value: any, options: { signal: AbortSignal }) => any,
    initialValue?: any,
    options?: Options
) {
    validateFunction(reducer, "reducer");
    validateOptions(options);
    let hasInitialValue = arguments.length > 1;
    if (options?.signal?.aborted) {
        const err = new AbortError(undefined, { cause: options.signal.reason });
        this.once("error", () => {}); // propagated already
        await finished(this.destroy(err));
        throw err;
    }
    const ac = new AbortController();
    const signal = ac.signal;
    options?.signal?.addEventListener("abort", () => ac.abort(), {
        once: true
    });
    let gotAnyItemFromStream = false;
    try {
        for await (const value of this) {
            gotAnyItemFromStream = true;
            if (options?.signal?.aborted) throw new AbortError();
            if (!hasInitialValue) {
                initialValue = value;
                hasInitialValue = true;
            } else {
                initialValue = await reducer(initialValue, value, { signal });
            }
        }
        if (!gotAnyItemFromStream && !hasInitialValue) {
            const err = ERR_MISSING_ARGS("reduce");
            err.message = "Reduce of an empty stream requires an initial value";
            throw err;
        }
    } finally {
        ac.abort();
    }
    return initialValue;
}

export async function toArray(this: any, options?: Options) {
    validateOptions(options);
    const result: any[] = [];
    for await (const val of this) {
        if (options?.signal?.aborted) {
            throw new AbortError(undefined, { cause: options.signal.reason });
        }
        result.push(val);
    }
    return result;
}

export function flatMap(this: any, fn: Fn, options?: Options) {
    const values = map.call(this, fn, options);
    return async function* flatMap() {
        for await (const val of values) yield* val;
    }.call(this);
}

function toIntegerOrInfinity(number: any) {
    number = Number(number);
    if (Number.isNaN(number)) return 0;
    if (number < 0) throw ERR_OUT_OF_RANGE("number", ">= 0", number);
    return number;
}

export function drop(this: any, number: number, options?: Options) {
    validateOptions(options);
    number = toIntegerOrInfinity(number);
    return async function* drop(this: any) {
        if (options?.signal?.aborted) throw new AbortError();
        for await (const val of this) {
            if (options?.signal?.aborted) throw new AbortError();
            if (number-- <= 0) yield val;
        }
    }.call(this);
}

export function take(this: any, number: number, options?: Options) {
    validateOptions(options);
    number = toIntegerOrInfinity(number);
    return async function* take(this: any) {
        if (options?.signal?.aborted) throw new AbortError();
        for await (const val of this) {
            if (options?.signal?.aborted) throw new AbortError();
            if (number-- > 0) yield val;
            if (number <= 0) return;
        }
    }.call(this);
}

export const streamReturningOperators = { drop, filter, flatMap, map, take };
export const promiseReturningOperators = {
    every,
    forEach,
    reduce,
    toArray,
    some,
    find
};
