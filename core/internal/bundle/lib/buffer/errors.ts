// The Node errors buffer and string_decoder throw: the error class Node uses
// (RangeError, TypeError, Error) with the `code` property Node sets, and
// messages built like lib/internal/errors.js builds them.

type NodeError = Error & { code: string };

function nodeError(
    Base: ErrorConstructor | RangeErrorConstructor | TypeErrorConstructor,
    code: string,
    message: string
): NodeError {
    const error = new Base(message) as NodeError;
    Object.defineProperty(error, "toString", {
        value() {
            return `${this.name} [${code}]: ${this.message}`;
        },
        enumerable: false,
        writable: true,
        configurable: true
    });
    error.code = code;
    return error;
}

// util.inspect for the primitives error messages show
function inspectValue(value: unknown): string {
    if (typeof value === "string") {
        return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
    }
    if (typeof value === "number") {
        return Object.is(value, -0) ? "-0" : String(value);
    }
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") {
        return `[Function: ${value.name || "(anonymous)"}]`;
    }
    if (value && typeof value === "object") {
        const name = value.constructor?.name;
        return name ? `${name} {}` : "[Object: null prototype] {}";
    }
    return String(value);
}

function determineSpecificType(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    switch (typeof value) {
        case "bigint":
            return `type bigint (${value}n)`;
        case "number":
            return `type number (${inspectValue(value)})`;
        case "boolean":
            return `type boolean (${value})`;
        case "symbol":
            return `type symbol (${String(value)})`;
        case "function":
            return `function ${value.name}`;
        case "object":
            if (value.constructor && "name" in value.constructor) {
                return `an instance of ${value.constructor.name}`;
            }
            return inspectValue(value);
        case "string": {
            const s = value.length > 28 ? `${value.slice(0, 25)}...` : value;
            return `type string (${inspectValue(s)})`;
        }
    }
    return `type ${typeof value} (${String(value)})`;
}

const PRIMITIVES = [
    "string",
    "function",
    "number",
    "object",
    "boolean",
    "bigint",
    "symbol"
];

function list(items: string[], prefix: string) {
    if (items.length > 2) {
        const last = items[items.length - 1];
        return `${prefix} ${items.slice(0, -1).join(", ")}, or ${last}`;
    }
    return items.length === 2
        ? `${prefix} ${items[0]} or ${items[1]}`
        : `${prefix} ${items[0]}`;
}

export function ERR_INVALID_ARG_TYPE(
    name: string,
    expected: string | string[],
    actual: unknown
) {
    const types: string[] = [];
    const instances: string[] = [];
    const other: string[] = [];
    for (const value of Array.isArray(expected) ? expected : [expected]) {
        if (PRIMITIVES.includes(value)) types.push(value.toLowerCase());
        else if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) instances.push(value);
        else other.push(value);
    }
    if (instances.length > 0 && types.includes("object")) {
        types.splice(types.indexOf("object"), 1);
        instances.push("Object");
    }

    let msg = name.endsWith(" argument")
        ? `The ${name} must be `
        : `The ${name.includes(".") ? "property" : "argument"} "${name}" must be `;
    const parts: string[] = [];
    if (types.length > 0) {
        parts.push(
            types.length === 1
                ? `of type ${types[0]}`
                : list(types, "one of type")
        );
    }
    if (instances.length > 0) parts.push(list(instances, "an instance of"));
    if (other.length > 0) {
        parts.push(
            other.length === 1
                ? `${other[0].toLowerCase() !== other[0] ? "an " : ""}${other[0]}`
                : list(other, "one of")
        );
    }
    msg += parts.join(" or ");
    msg += `. Received ${determineSpecificType(actual)}`;
    return nodeError(TypeError, "ERR_INVALID_ARG_TYPE", msg);
}

function addNumericalSeparator(value: string) {
    let res = "";
    let i = value.length;
    const start = value[0] === "-" ? 1 : 0;
    for (; i >= start + 4; i -= 3) {
        res = `_${value.slice(i - 3, i)}${res}`;
    }
    return `${value.slice(0, i)}${res}`;
}

export function ERR_OUT_OF_RANGE(name: string, range: string, input: unknown) {
    let received: string;
    if (Number.isInteger(input) && Math.abs(input as number) > 2 ** 32) {
        received = addNumericalSeparator(String(input));
    } else if (typeof input === "bigint") {
        received = String(input);
        if (input > 2n ** 32n || input < -(2n ** 32n)) {
            received = addNumericalSeparator(received);
        }
        received += "n";
    } else {
        received = inspectValue(input);
    }
    return nodeError(
        RangeError,
        "ERR_OUT_OF_RANGE",
        `The value of "${name}" is out of range. It must be ${range}. Received ${received}`
    );
}

// what the C++ side of Node throws for a bad index (THROW_AND_RETURN_IF_OOB)
export function ERR_INDEX_OUT_OF_RANGE() {
    return nodeError(RangeError, "ERR_OUT_OF_RANGE", "Index out of range");
}

export function ERR_BUFFER_OUT_OF_BOUNDS(name?: string) {
    return nodeError(
        RangeError,
        "ERR_BUFFER_OUT_OF_BOUNDS",
        name
            ? `"${name}" is outside of buffer bounds`
            : "Attempt to access memory outside buffer bounds"
    );
}

export function ERR_INVALID_ARG_VALUE(
    name: string,
    value: unknown,
    reason = "is invalid"
) {
    const type = name.includes(".") ? "property" : "argument";
    return nodeError(
        TypeError,
        "ERR_INVALID_ARG_VALUE",
        `The ${type} '${name}' ${reason}. Received ${inspectValue(value)}`
    );
}

export function ERR_UNKNOWN_ENCODING(encoding: unknown) {
    return nodeError(
        TypeError,
        "ERR_UNKNOWN_ENCODING",
        `Unknown encoding: ${String(encoding)}`
    );
}

export function ERR_INVALID_BUFFER_SIZE(size: string) {
    return nodeError(
        RangeError,
        "ERR_INVALID_BUFFER_SIZE",
        `Buffer size must be a multiple of ${size}`
    );
}

export function ERR_MISSING_ARGS(name: string) {
    return nodeError(
        TypeError,
        "ERR_MISSING_ARGS",
        `The "${name}" argument must be specified`
    );
}

// transcode's ICU failures: a plain Error with the ICU error name as code
export function transcodeError(code: string, errno: number) {
    const error = new Error(`Unable to transcode Buffer [${code}]`) as Error & {
        code: string;
        errno: number;
    };
    error.code = code;
    error.errno = errno;
    return error;
}

// lib/internal/validators.js
export function validateNumber(
    value: unknown,
    name: string,
    min?: number,
    max?: number
): asserts value is number {
    if (typeof value !== "number") {
        throw ERR_INVALID_ARG_TYPE(name, "number", value);
    }
    if (
        (min != null && value < min) ||
        (max != null && value > max) ||
        ((min != null || max != null) && Number.isNaN(value))
    ) {
        throw ERR_OUT_OF_RANGE(
            name,
            `${min != null ? `>= ${min}` : ""}${min != null && max != null ? " && " : ""}${max != null ? `<= ${max}` : ""}`,
            value
        );
    }
}

export function validateInteger(
    value: unknown,
    name: string,
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER
): asserts value is number {
    if (typeof value !== "number") {
        throw ERR_INVALID_ARG_TYPE(name, "number", value);
    }
    if (!Number.isInteger(value)) {
        throw ERR_OUT_OF_RANGE(name, "an integer", value);
    }
    if (value < min || value > max) {
        throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
    }
}

// lib/buffer.js validateOffset: an integer, from 0 by default
export function validateOffset(
    value: unknown,
    name: string,
    min = 0,
    max = Number.MAX_SAFE_INTEGER
): asserts value is number {
    validateInteger(value, name, min, max);
}
