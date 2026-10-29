// node:util (Node 24, the version test/shim compares with), improvements/shim/plan.md 5.4.
//
// inspect and format live in ./inspect.ts, the deep equality shared with
// assert in ./comparisons.ts, the type checks in ./types.ts (util.types).
// `require("util")` gets the util object (the "module.exports" export,
// bundle.go libRequireAdapter): npm shims call require("util").inherits,
// .deprecate, .debuglog and .inspect on it.
//
// Not here: getSystemErrorName/getSystemErrorMap (the errno table is the
// host's), MIMEType, getCallSites, parseEnv, diff.

import type * as NodeUtil from "node:util";
import types from "./types.ts";
import { isDate, isNativeError, isPromise, isRegExp } from "./types.ts";
import { inspect, format, formatWithOptions } from "./inspect.ts";
import { isDeepStrictEqual } from "./comparisons.ts";
import { parseArgs } from "./parseArgs.ts";
import {
    emitWarning,
    invalidArgType,
    nodeError,
    validateFunction,
    validateString
} from "./internal.ts";

// promisify

const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");
const kCustomPromiseArgs = Symbol.for("nodejs.util.promisify.customArgs");

type AnyFunction = (...args: any[]) => any;

function copyProperties(target: Function, original: Function) {
    const descriptors = Object.getOwnPropertyDescriptors(original);
    for (const descriptor of Object.values(descriptors)) {
        Object.setPrototypeOf(descriptor, null);
    }
    return Object.defineProperties(target, descriptors);
}

function promisify(original: AnyFunction): AnyFunction {
    validateFunction(original, "original");
    const custom = (original as any)[kCustomPromisifiedSymbol];
    if (custom) {
        validateFunction(custom, "util.promisify.custom");
        return Object.defineProperty(custom, kCustomPromisifiedSymbol, {
            value: custom,
            enumerable: false,
            writable: false,
            configurable: true
        });
    }
    const argumentNames: string[] | undefined = (original as any)[
        kCustomPromiseArgs
    ];

    // `arguments` copied by hand and function callbacks: measurably faster
    // than rest parameters and arrows on V8 and JavaScriptCore
    function fn(this: unknown) {
        // var, not let: no hole check in the callbacks
        // eslint-disable-next-line no-var
        var resolve: (value: unknown) => void,
            reject: (reason: unknown) => void;
        const promise = new Promise(function (res, rej) {
            resolve = res;
            reject = rej;
        });
        const args: unknown[] = [];
        for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
        if (argumentNames === undefined) {
            args.push(function (err: unknown, value: unknown) {
                if (err) reject(err);
                else resolve(value);
            });
        } else {
            args.push(function (err: unknown, ...values: unknown[]) {
                if (err) return reject(err);
                if (values.length > 1) {
                    const obj: Record<string, unknown> = {};
                    for (let i = 0; i < argumentNames.length; i++) {
                        obj[argumentNames[i]] = values[i];
                    }
                    resolve(obj);
                } else {
                    resolve(values[0]);
                }
            });
        }
        // a synchronous throw rejects, as in Node's promise executor
        try {
            const result = original.apply(this, args);
            if (result !== undefined && isPromise(result)) {
                emitWarning(
                    "Calling promisify on a function that returns a Promise is likely a mistake.",
                    "DeprecationWarning",
                    "DEP0174"
                );
            }
        } catch (error) {
            reject(error);
        }
        return promise;
    }

    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisifiedSymbol, {
        value: fn,
        enumerable: false,
        writable: false,
        configurable: true
    });
    return copyProperties(fn, original) as AnyFunction;
}

promisify.custom = kCustomPromisifiedSymbol;

// callbackify

function callbackifyOnRejected(reason: unknown, cb: AnyFunction) {
    // a falsy rejection is wrapped: null in a callback means no error
    if (!reason) {
        const error = nodeError(
            new Error("Promise was rejected with falsy value"),
            "ERR_FALSY_VALUE_REJECTION"
        ) as Error & { reason?: unknown };
        error.reason = reason;
        reason = error;
    }
    return cb(reason);
}

function callbackify(original: AnyFunction): AnyFunction {
    validateFunction(original, "original");

    function callbackified(this: unknown, ...args: unknown[]) {
        const maybeCb = args.pop();
        validateFunction(maybeCb, "last argument");
        const cb = (maybeCb as AnyFunction).bind(this);
        Reflect.apply(original, this, args).then(
            (ret: unknown) => queueMicrotask(() => cb(null, ret)),
            (rej: unknown) =>
                queueMicrotask(() => callbackifyOnRejected(rej, cb))
        );
    }

    const descriptors = Object.getOwnPropertyDescriptors(original);
    if (typeof descriptors.length.value === "number") {
        descriptors.length.value++;
    }
    if (typeof descriptors.name.value === "string") {
        descriptors.name.value += "Callbackified";
    }
    for (const descriptor of Object.values(descriptors)) {
        Object.setPrototypeOf(descriptor, null);
    }
    Object.defineProperties(callbackified, descriptors);
    return callbackified;
}

// inherits, deprecate

function inherits(ctor: Function, superCtor: Function) {
    if (ctor === undefined || ctor === null) {
        throw invalidArgType("ctor", "of type function", ctor);
    }
    if (superCtor === undefined || superCtor === null) {
        throw invalidArgType("superCtor", "of type function", superCtor);
    }
    if (superCtor.prototype === undefined) {
        throw invalidArgType(
            "superCtor.prototype",
            "of type object",
            superCtor.prototype
        );
    }
    Object.defineProperty(ctor, "super_", {
        value: superCtor,
        writable: true,
        configurable: true
    });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

const codesWarned = new Set<string>();

function deprecate<T extends AnyFunction>(
    fn: T,
    msg: string,
    code?: string
): T {
    if (code !== undefined) validateString(code, "code");
    let warned = false;

    function deprecated(this: unknown, ...args: unknown[]) {
        if (!(globalThis as any).process?.noDeprecation && !warned) {
            warned = true;
            if (code !== undefined) {
                if (!codesWarned.has(code)) {
                    codesWarned.add(code);
                    emitWarning(msg, "DeprecationWarning", code);
                }
            } else {
                emitWarning(msg, "DeprecationWarning");
            }
        }
        if (new.target) return Reflect.construct(fn, args, new.target);
        return Reflect.apply(fn, this, args);
    }

    Object.setPrototypeOf(deprecated, fn);
    if (fn.prototype) deprecated.prototype = fn.prototype;
    Object.defineProperty(
        deprecated,
        "length",
        Object.getOwnPropertyDescriptor(fn, "length")
    );
    return deprecated as unknown as T;
}

// debuglog: NODE_DEBUG is read once, at the first log or `.enabled`

type DebugLogger = ((...args: unknown[]) => void) & { enabled: boolean };

let testEnabled: ((section: string) => boolean) | undefined;

function initializeDebugEnv() {
    let debugEnv: string | undefined;
    try {
        debugEnv = (globalThis as any).process?.env?.NODE_DEBUG;
    } catch {}
    if (debugEnv) {
        const pattern = debugEnv
            .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
            .replaceAll("*", ".*")
            .replaceAll(",", "$|^");
        const regex = new RegExp(`^${pattern}$`, "i");
        return (section: string) => regex.test(section);
    }
    return () => false;
}

function debuglog(
    section: string,
    cb?: (fn: (...args: unknown[]) => void) => void
): DebugLogger {
    let enabled: boolean | undefined;
    let impl: ((...args: unknown[]) => void) | undefined;
    const set = String(section).toUpperCase();
    const isEnabled = () => {
        if (enabled === undefined) {
            testEnabled ??= initializeDebugEnv();
            enabled = testEnabled(set);
        }
        return enabled;
    };
    const logger = ((...args: unknown[]) => {
        if (enabled === false) return;
        if (impl === undefined) {
            impl = isEnabled()
                ? (...args: unknown[]) => {
                      const pid = (globalThis as any).process?.pid ?? 0;
                      console.error(`${set} ${pid}: ${format(...args)}`);
                  }
                : () => {};
            if (typeof cb === "function") {
                Object.defineProperty(impl, "enabled", {
                    get: isEnabled,
                    configurable: true,
                    enumerable: true
                });
                cb(impl);
            }
        }
        impl(...args);
    }) as DebugLogger;
    Object.defineProperty(logger, "enabled", {
        get: isEnabled,
        configurable: true,
        enumerable: true
    });
    return logger;
}

// styleText, stripVTControlCharacters

function shouldColorize(stream: any) {
    const env = (() => {
        try {
            return (globalThis as any).process?.env ?? {};
        } catch {
            return {};
        }
    })();
    if (env.FORCE_COLOR !== undefined) {
        return (
            env.FORCE_COLOR === "" ||
            env.FORCE_COLOR === "1" ||
            env.FORCE_COLOR === "2" ||
            env.FORCE_COLOR === "3" ||
            env.FORCE_COLOR === "true"
        );
    }
    if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined) {
        return false;
    }
    return !!stream?.isTTY;
}

function styleText(
    format: string | string[],
    text: string,
    {
        validateStream = true,
        stream = (globalThis as any).process?.stdout
    }: { validateStream?: boolean; stream?: unknown } = {}
) {
    validateString(text, "text");
    if (typeof validateStream !== "boolean") {
        throw invalidArgType(
            "options.validateStream",
            "of type boolean",
            validateStream
        );
    }
    const skipColorize = validateStream && !shouldColorize(stream);
    const formats = Array.isArray(format) ? format : [format];
    let left = "";
    let right = "";
    for (const key of formats) {
        if (key === "none") continue;
        const codes = inspect.colors[key];
        if (codes == null) {
            const names = Object.keys(inspect.colors)
                .map((name) => `'${name}'`)
                .join(", ");
            throw nodeError(
                new TypeError(
                    `The argument 'format' must be one of: ${names}. Received ${inspect(key)}`
                ),
                "ERR_INVALID_ARG_VALUE"
            );
        }
        if (skipColorize) continue;
        left += `\u001b[${codes[0]}m`;
        right = `\u001b[${codes[1]}m${right}`;
    }
    return skipColorize ? text : `${left}${text}${right}`;
}

const ansi = new RegExp(
    "[\\u001B\\u009B][[\\]()#;?]*" +
        "(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*" +
        "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?" +
        "(?:\\u0007|\\u001B\\u005C|\\u009C))" +
        "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?" +
        "[\\dA-PR-TZcf-nq-uy=><~]))",
    "g"
);

function stripVTControlCharacters(str: string) {
    validateString(str, "str");
    return str.replace(ansi, "");
}

function toUSVString(input: unknown) {
    const str = `${input}`;
    if (typeof (str as any).toWellFormed === "function") {
        return (str as any).toWellFormed() as string;
    }
    return str.replace(/[\ud800-\udfff]/gu, "�");
}

// aborted, transferable signals

function aborted(signal: AbortSignal, resource: object): Promise<void> {
    if (
        signal === null ||
        typeof signal !== "object" ||
        !("aborted" in signal)
    ) {
        throw invalidArgType("signal", "an instance of AbortSignal", signal);
    }
    if (
        resource === null ||
        (typeof resource !== "object" && typeof resource !== "function")
    ) {
        throw invalidArgType("resource", "of type object", resource);
    }
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

function transferableAbortSignal(signal: AbortSignal) {
    return signal;
}

function transferableAbortController() {
    return new AbortController();
}

// the helpers Node 23 removed, still called by old npm packages

const isArray = Array.isArray;
const isBoolean = (arg: unknown) => typeof arg === "boolean";
const isNull = (arg: unknown) => arg === null;
const isNullOrUndefined = (arg: unknown) => arg === null || arg === undefined;
const isNumber = (arg: unknown) => typeof arg === "number";
const isString = (arg: unknown) => typeof arg === "string";
const isSymbol = (arg: unknown) => typeof arg === "symbol";
const isUndefined = (arg: unknown) => arg === undefined;
const isObject = (arg: unknown) => arg !== null && typeof arg === "object";
const isError = (arg: unknown) => isNativeError(arg) || arg instanceof Error;
const isFunction = (arg: unknown) => typeof arg === "function";
const isPrimitive = (arg: unknown) =>
    arg === null || (typeof arg !== "object" && typeof arg !== "function");
const isBuffer = (arg: unknown): boolean =>
    !!(globalThis as any).Buffer?.isBuffer?.(arg);

const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
];

function log(...args: unknown[]) {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    console.log(
        `${d.getDate()} ${months[d.getMonth()]} ${time} - ${format(...args)}`
    );
}

function _extend(target: object, source: object) {
    if (source === null || typeof source !== "object") return target;
    for (const key of Object.keys(source)) {
        (target as any)[key] = (source as any)[key];
    }
    return target;
}

const TextEncoder = globalThis.TextEncoder;
const TextDecoder = globalThis.TextDecoder;
const debug = debuglog;

const util = {
    _extend,
    callbackify,
    debug,
    debuglog,
    deprecate,
    format,
    formatWithOptions,
    styleText,
    inherits,
    inspect,
    isArray,
    isBoolean,
    isBuffer,
    isDate,
    isDeepStrictEqual,
    isError,
    isFunction,
    isNull,
    isNullOrUndefined,
    isNumber,
    isObject,
    isPrimitive,
    isRegExp,
    isString,
    isSymbol,
    isUndefined,
    log,
    parseArgs,
    promisify,
    stripVTControlCharacters,
    toUSVString,
    transferableAbortSignal,
    transferableAbortController,
    aborted,
    types,
    TextDecoder,
    TextEncoder
};

// typed as Node's for the importers of this file
const Exported = util as unknown as typeof NodeUtil;

export {
    Exported as default,
    Exported as "module.exports",
    _extend,
    callbackify,
    debug,
    debuglog,
    deprecate,
    format,
    formatWithOptions,
    styleText,
    inherits,
    inspect,
    isArray,
    isBoolean,
    isBuffer,
    isDate,
    isDeepStrictEqual,
    isError,
    isFunction,
    isNull,
    isNullOrUndefined,
    isNumber,
    isObject,
    isPrimitive,
    isRegExp,
    isString,
    isSymbol,
    isUndefined,
    log,
    parseArgs,
    promisify,
    stripVTControlCharacters,
    toUSVString,
    transferableAbortSignal,
    transferableAbortController,
    aborted,
    types,
    TextDecoder,
    TextEncoder
};
