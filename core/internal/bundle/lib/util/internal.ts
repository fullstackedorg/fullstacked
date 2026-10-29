// Internals of util and assert: errors with Node's codes (the class and
// `code` are Node's, the messages follow Node's wording) and small helpers.

export function nodeError<E extends Error>(error: E, code: string): E {
    (error as E & { code: string }).code = code;
    return error;
}

function received(value: unknown) {
    if (value == null) return ` Received ${value}`;
    if (typeof value === "function") {
        return ` Received function ${value.name || "<anonymous>"}`;
    }
    if (typeof value === "object") {
        const name = (value as object).constructor?.name;
        return name
            ? ` Received an instance of ${name}`
            : ` Received ${Object.prototype.toString.call(value)}`;
    }
    let shown =
        typeof value === "symbol" ? value.toString() : String(value as string);
    if (typeof value === "string") {
        if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
        shown = `'${shown}'`;
    } else if (typeof value === "bigint") {
        shown += "n";
    }
    return ` Received type ${typeof value} (${shown})`;
}

// `expected` reads after "must be": "of type function", "an instance of
// Promise", ...
export function invalidArgType(name: string, expected: string, value: unknown) {
    const kind = name.includes(".") ? "property" : "argument";
    return nodeError(
        new TypeError(
            `The "${name}" ${kind} must be ${expected}.${received(value)}`
        ),
        "ERR_INVALID_ARG_TYPE"
    );
}

export function invalidArgValue(name: string, value: unknown, reason: string) {
    const kind = name.includes(".") ? "property" : "argument";
    let shown: string;
    try {
        shown = typeof value === "string" ? `'${value}'` : String(value);
    } catch {
        shown = Object.prototype.toString.call(value);
    }
    if (typeof value === "object" && value !== null) {
        try {
            shown = JSON.stringify(value) ?? shown;
        } catch {}
    }
    return nodeError(
        new TypeError(`The ${kind} '${name}' ${reason}. Received ${shown}`),
        "ERR_INVALID_ARG_VALUE"
    );
}

export function validateFunction(value: unknown, name: string) {
    if (typeof value !== "function") {
        throw invalidArgType(name, "of type function", value);
    }
}

export function validateString(value: unknown, name: string) {
    if (typeof value !== "string") {
        throw invalidArgType(name, "of type string", value);
    }
}

export function validateObject(value: unknown, name: string) {
    if (value === null || typeof value !== "object") {
        throw invalidArgType(name, "of type object", value);
    }
}

// process.emitWarning when the runtime has it, the console otherwise
export function emitWarning(message: string, type: string, code?: string) {
    const proc = (globalThis as any).process;
    if (typeof proc?.emitWarning === "function") {
        if (code === undefined) proc.emitWarning(message, type);
        else proc.emitWarning(message, type, code);
        return;
    }
    console.warn(`${code ? `[${code}] ` : ""}${type}: ${message}`);
}

// shared by the util modules

export const hasOwn = (object: object, key: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(object, key);

export const isEnumerable = (object: object, key: PropertyKey) =>
    Object.prototype.propertyIsEnumerable.call(object, key);

export const objectToString = Object.prototype.toString;

// the typed array kind ("Uint8Array", ...) or undefined, never throws
export const typedArrayKind = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag
).get as (this: unknown) => string | undefined;

// an array index ("0", "1", ... below 2 ** 32 - 1)
export function isIndex(key: string) {
    const length = key.length;
    if (length === 0 || length > 10) return false;
    const first = key.charCodeAt(0);
    if (first < 48 || first > 57 || (first === 48 && length > 1)) return false;
    for (let i = 1; i < length; i++) {
        const code = key.charCodeAt(i);
        if (code < 48 || code > 57) return false;
    }
    return +key < 4294967295;
}

// Node's isURL: what has a URL's shape
export const isURL = (value: any) =>
    Boolean(
        value?.href &&
        value.protocol &&
        value.auth === undefined &&
        value.path === undefined
    );
