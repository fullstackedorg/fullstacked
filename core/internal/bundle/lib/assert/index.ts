// node:assert (Node 24, the version test/shim compares with), improvements/shim/plan.md 5.4.
//
// The deep equality is util's (../util/comparisons.ts). Messages are made
// with inspect like Node's: `actual !== expected` for short single-line
// values, a line diff (`+ actual - expected`) otherwise. assert.ok() without
// a message cannot quote the source expression as Node does (it reads the
// file): its message is `value == true`.
//
// `require("assert")` gets the assert function with every method on it (the
// "module.exports" export, bundle.go libRequireAdapter): npm packages call
// `require("assert")(cond, msg)`.

import type * as NodeAssert from "node:assert";
import { inspect } from "../util/inspect.ts";
import {
    isDeepEqual,
    isDeepStrictEqual,
    isPartialStrictEqual
} from "../util/comparisons.ts";
import { isNativeError, isPromise, isRegExp } from "../util/types.ts";
import {
    emitWarning,
    invalidArgType,
    invalidArgValue,
    nodeError,
    validateFunction
} from "../util/internal.ts";

type AnyFunction = (...args: any[]) => any;
type Message = string | Error | undefined;

const kReadableOperator: Record<string, string> = {
    deepStrictEqual: "Expected values to be strictly deep-equal:",
    partialDeepStrictEqual:
        "Expected values to be partially and strictly deep-equal:",
    strictEqual: "Expected values to be strictly equal:",
    strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
    deepEqual: "Expected values to be loosely deep-equal:",
    notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
    notStrictEqual: 'Expected "actual" to be strictly unequal to:',
    notStrictEqualObject:
        'Expected "actual" not to be reference-equal to "expected":',
    notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
    notIdentical: "Values have same structure but are not reference-equal:",
    notDeepEqualUnequal: "Expected values not to be loosely deep-equal:"
};

const kMaxShortStringLength = 12;
const kMaxLongStringLength = 512;
const kNopLinesToCollapse = 5;

// the operators whose message is a diff, even under a custom message
const kMethodsWithCustomMessageDiff = new Set([
    "deepStrictEqual",
    "strictEqual",
    "partialDeepStrictEqual"
]);

function inspectValue(value: unknown) {
    return inspect(value, {
        compact: false,
        customInspect: false,
        depth: 1000,
        maxArrayLength: Infinity,
        showHidden: false,
        showProxy: false,
        sorted: true,
        getters: true
    });
}

// an error without its stack, for the message of two errors
function copyError(source: any): any {
    const target = Object.assign(
        Object.create(Object.getPrototypeOf(source)),
        source
    );
    Object.defineProperty(target, "message", { value: source.message });
    if (Object.prototype.hasOwnProperty.call(source, "cause")) {
        let { cause } = source;
        if (isError(cause)) cause = copyError(cause);
        Object.defineProperty(target, "cause", { value: cause });
    }
    return target;
}

// Node's line diff (internal/assert/myers_diff): [operation, line] from the
// last line, 1 for a line of actual only, -1 of expected only, 0 for both
function myersDiff(actual: string[], expected: string[], commas: boolean) {
    const same = (a: string, b: string) =>
        a === b || (commas && (`${a},` === b || a === `${b},`));
    const actualLength = actual.length;
    const expectedLength = expected.length;
    const max = actualLength + expectedLength;
    const v = new Int32Array(2 * max + 1);
    const trace: Int32Array[] = [];
    for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
        trace.push(new Int32Array(v));
        for (let k = -diffLevel; k <= diffLevel; k += 2) {
            const offset = k + max;
            let x =
                k === -diffLevel ||
                (k !== diffLevel && v[offset - 1] < v[offset + 1])
                    ? v[offset + 1]
                    : v[offset - 1] + 1;
            let y = x - k;
            while (
                x < actualLength &&
                y < expectedLength &&
                same(actual[x], expected[y])
            ) {
                x++;
                y++;
            }
            v[offset] = x;
            if (x >= actualLength && y >= expectedLength) {
                return backtrack(trace, actual, expected, commas);
            }
        }
    }
    return [];
}

function backtrack(
    trace: Int32Array[],
    actual: string[],
    expected: string[],
    commas: boolean
) {
    const max = actual.length + expected.length;
    let x = actual.length;
    let y = expected.length;
    const result: [number, string][] = [];
    for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
        const v = trace[diffLevel];
        const k = x - y;
        const offset = k + max;
        const prevK =
            k === -diffLevel ||
            (k !== diffLevel && v[offset - 1] < v[offset + 1])
                ? k + 1
                : k - 1;
        const prevX = v[prevK + max];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            const actualItem = actual[x - 1];
            result.push([
                0,
                commas && !actualItem.endsWith(",")
                    ? expected[y - 1]
                    : actualItem
            ]);
            x--;
            y--;
        }
        if (diffLevel > 0) {
            if (x > prevX) result.push([1, actual[--x]]);
            else result.push([-1, expected[--y]]);
        }
    }
    return result;
}

function printMyersDiff(diff: [number, string][]) {
    let message = "";
    let skipped = false;
    let nopCount = 0;
    for (let i = diff.length - 1; i >= 0; i--) {
        const [operation, value] = diff[i];
        const previous = i < diff.length - 1 ? diff[i + 1][0] : null;
        // runs of unchanged lines are collapsed, not a single line
        if (previous === 0 && operation !== previous) {
            if (nopCount === kNopLinesToCollapse + 1) {
                message += `  ${diff[i + 1][1]}\n`;
            } else if (nopCount === kNopLinesToCollapse + 2) {
                message += `  ${diff[i + 2][1]}\n  ${diff[i + 1][1]}\n`;
            } else if (nopCount >= kNopLinesToCollapse + 3) {
                message += `...\n  ${diff[i + 1][1]}\n`;
                skipped = true;
            }
            nopCount = 0;
        }
        if (operation === 1) {
            message += `+ ${value}\n`;
        } else if (operation === -1) {
            message += `- ${value}\n`;
        } else {
            if (nopCount < kNopLinesToCollapse) message += `  ${value}\n`;
            nopCount++;
        }
    }
    return { message: `\n${message.trimEnd()}`, skipped };
}

function createErrDiff(
    actual: unknown,
    expected: unknown,
    operator: string,
    customMessage: unknown,
    diffType: string
) {
    if (
        operator === "strictEqual" &&
        ((typeof actual === "object" &&
            actual !== null &&
            typeof expected === "object" &&
            expected !== null) ||
            (typeof actual === "function" && typeof expected === "function"))
    ) {
        operator = "strictEqualObject";
    }
    let skipped = false;
    let message: string;
    const inspectedActual = inspectValue(actual);
    const inspectedExpected = inspectValue(expected);
    const actualLines = inspectedActual.split("\n");
    const expectedLines = inspectedExpected.split("\n");
    let header = "+ actual - expected";
    if (
        actualLines.length === 1 &&
        expectedLines.length === 1 &&
        (typeof actual !== "object" ||
            actual === null ||
            typeof expected !== "object" ||
            expected === null)
    ) {
        // a single line: `actual !== expected`, or both under each other
        let stringsLength = inspectedActual.length + inspectedExpected.length;
        if (typeof actual === "string") stringsLength -= 2;
        if (typeof expected === "string") stringsLength -= 2;
        if (
            stringsLength <= kMaxShortStringLength &&
            (actual !== 0 || expected !== 0)
        ) {
            header = "";
            message = `${inspectedActual} !== ${inspectedExpected}`;
        } else {
            message = `\n+ ${inspectedActual}\n- ${inspectedExpected}`;
            if (inspectedActual.length + inspectedExpected.length <= 80) {
                for (let i = 0; i < inspectedActual.length; i++) {
                    if (inspectedActual[i] !== inspectedExpected[i]) {
                        if (i >= 3) message += `\n${" ".repeat(i + 2)}^`;
                        break;
                    }
                }
            }
        }
    } else if (inspectedActual === inspectedExpected) {
        operator = "notIdentical";
        if (actualLines.length > 50 && diffType !== "full") {
            message = `${actualLines.slice(0, 50).join("\n")}\n...}`;
            skipped = true;
        } else {
            message = inspectedActual;
        }
        header = "";
    } else {
        const diff = printMyersDiff(
            myersDiff(
                actualLines,
                expectedLines,
                actual != null && typeof actual === "object"
            )
        );
        message = diff.message;
        skipped = diff.skipped;
    }
    return `${customMessage || kReadableOperator[operator]}\n${header}${
        skipped ? "\n... Skipped lines" : ""
    }\n${message}\n`;
}

// AssertionError

type AssertionErrorOptions = {
    message?: unknown;
    actual?: unknown;
    expected?: unknown;
    operator?: string;
    stackStartFn?: Function;
    stackStartFunction?: Function;
    diff?: string;
};

class AssertionError extends Error {
    // set in Node's order, which is the order inspect shows them in
    declare generatedMessage: boolean;
    declare code: "ERR_ASSERTION";
    declare actual: unknown;
    declare expected: unknown;
    declare operator: string;
    declare diff: string;

    constructor(options: AssertionErrorOptions) {
        if (options === null || typeof options !== "object") {
            throw invalidArgType("options", "of type object", options);
        }
        const { message, operator, diff = "simple" } = options;
        let { actual, expected } = options;
        let text: string;
        if (message != null) {
            text = kMethodsWithCustomMessageDiff.has(operator)
                ? createErrDiff(actual, expected, operator, message, diff)
                : String(message);
        } else {
            // two errors are shown without their stacks
            if (
                isError(actual) &&
                isError(expected) &&
                "stack" in (actual as object) &&
                "stack" in (expected as object)
            ) {
                actual = copyError(actual);
                expected = copyError(expected);
            }
            if (kMethodsWithCustomMessageDiff.has(operator)) {
                text = createErrDiff(actual, expected, operator, message, diff);
            } else if (
                operator === "notDeepStrictEqual" ||
                operator === "notStrictEqual"
            ) {
                let base = kReadableOperator[operator];
                const res = inspectValue(actual).split("\n");
                if (
                    operator === "notStrictEqual" &&
                    ((typeof actual === "object" && actual !== null) ||
                        typeof actual === "function")
                ) {
                    base = kReadableOperator.notStrictEqualObject;
                }
                if (res.length > 50 && diff !== "full") {
                    res[46] = "...";
                    res.length = 47;
                }
                text =
                    res.length === 1
                        ? `${base}${res[0].length > 5 ? "\n\n" : " "}${res[0]}`
                        : `${base}\n\n${res.join("\n")}\n`;
            } else {
                let res = inspectValue(actual);
                let other = inspectValue(expected);
                const knownOperator = kReadableOperator[operator];
                if (operator === "notDeepEqual" && res === other) {
                    res = `${knownOperator}\n\n${res}`;
                    if (res.length > 1024 && diff !== "full") {
                        res = `${res.slice(0, 1021)}...`;
                    }
                    text = res;
                } else {
                    if (res.length > kMaxLongStringLength && diff !== "full") {
                        res = `${res.slice(0, 509)}...`;
                    }
                    if (
                        other.length > kMaxLongStringLength &&
                        diff !== "full"
                    ) {
                        other = `${other.slice(0, 509)}...`;
                    }
                    if (operator === "deepEqual") {
                        res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
                    } else {
                        const newOp = kReadableOperator[`${operator}Unequal`];
                        if (newOp) {
                            res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
                        } else {
                            other = ` ${operator} ${other}`;
                        }
                    }
                    text = `${res}${other}`;
                }
            }
        }
        super(text);
        this.generatedMessage = !message;
        Object.defineProperty(this, "name", {
            value: "AssertionError [ERR_ASSERTION]",
            enumerable: false,
            writable: true,
            configurable: true
        });
        this.code = "ERR_ASSERTION";
        this.actual = actual;
        this.expected = expected;
        this.operator = operator;
        const stackStartFn = options.stackStartFn || options.stackStartFunction;
        const capture = (Error as any).captureStackTrace;
        if (typeof capture === "function" && stackStartFn) {
            capture(this, stackStartFn);
        }
        // the stack starts with the name and code, as in Node
        this.stack;
        this.name = "AssertionError";
        this.diff = diff;
    }

    toString() {
        return `${this.name} [${this.code}]: ${this.message}`;
    }

    // actual and expected are shown at depth 0, long strings cut
    [Symbol.for("nodejs.util.inspect.custom")](
        _recurseTimes: number,
        ctx: object
    ) {
        const { actual, expected } = this;
        if (typeof actual === "string") this.actual = addEllipsis(actual);
        if (typeof expected === "string") this.expected = addEllipsis(expected);
        const result = inspect(this, {
            ...ctx,
            customInspect: false,
            depth: 0
        });
        this.actual = actual;
        this.expected = expected;
        return result;
    }
}

function addEllipsis(string: string) {
    const lines = string.split("\n", 11);
    if (lines.length > 10) {
        lines.length = 10;
        return `${lines.join("\n")}\n...`;
    } else if (string.length > kMaxLongStringLength) {
        // Node keeps the end of the string here
        return `${string.slice(kMaxLongStringLength)}...`;
    }
    return string;
}

// the assertions

function innerFail(obj: AssertionErrorOptions): never {
    if (obj.message instanceof Error) throw obj.message;
    throw new AssertionError(obj);
}

function missingArgs() {
    return nodeError(
        new TypeError(
            'The "actual" and "expected" arguments must be specified'
        ),
        "ERR_MISSING_ARGS"
    );
}

function innerOk(
    fn: Function,
    argLen: number,
    value: unknown,
    message: Message
) {
    if (!value) {
        let generatedMessage = false;
        if (argLen === 0) {
            generatedMessage = true;
            message = "No value argument passed to `assert.ok()`";
        } else if (message == null) {
            generatedMessage = true;
        } else if (message instanceof Error) {
            throw message;
        }
        const err = new AssertionError({
            actual: value,
            expected: true,
            message,
            operator: "==",
            stackStartFn: fn
        });
        err.generatedMessage = generatedMessage;
        throw err;
    }
}

function ok(value?: unknown, message?: Message): asserts value {
    innerOk(ok, arguments.length, value, message);
}

let warned = false;

function fail(
    actual?: unknown,
    expected?: unknown,
    message?: Message,
    operator?: string,
    stackStartFn?: Function
): never {
    const argsLen = arguments.length;
    let internalMessage = false;
    if (actual == null && argsLen <= 1) {
        internalMessage = true;
        message = "Failed";
    } else if (argsLen === 1) {
        message = actual as Message;
        actual = undefined;
    } else {
        if (!warned) {
            warned = true;
            emitWarning(
                "assert.fail() with more than one argument is deprecated. Please use assert.strictEqual() instead or only pass a message.",
                "DeprecationWarning",
                "DEP0094"
            );
        }
        if (argsLen === 2) operator = "!=";
    }
    if (message instanceof Error) throw message;
    const err = new AssertionError({
        actual,
        expected,
        operator: operator === undefined ? "fail" : operator,
        stackStartFn: stackStartFn || fail,
        message
    });
    if (internalMessage) err.generatedMessage = true;
    throw err;
}

function equal(actual: unknown, expected: unknown, message?: Message) {
    if (arguments.length < 2) throw missingArgs();
    // eslint-disable-next-line eqeqeq
    if (
        actual != expected &&
        (!Number.isNaN(actual) || !Number.isNaN(expected))
    ) {
        innerFail({
            actual,
            expected,
            message,
            operator: "==",
            stackStartFn: equal
        });
    }
}

function notEqual(actual: unknown, expected: unknown, message?: Message) {
    if (arguments.length < 2) throw missingArgs();
    // eslint-disable-next-line eqeqeq
    if (
        actual == expected ||
        (Number.isNaN(actual) && Number.isNaN(expected))
    ) {
        innerFail({
            actual,
            expected,
            message,
            operator: "!=",
            stackStartFn: notEqual
        });
    }
}

function deepEqual(actual: unknown, expected: unknown, message?: Message) {
    if (arguments.length < 2) throw missingArgs();
    if (!isDeepEqual(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "deepEqual",
            stackStartFn: deepEqual
        });
    }
}

function notDeepEqual(actual: unknown, expected: unknown, message?: Message) {
    if (arguments.length < 2) throw missingArgs();
    if (isDeepEqual(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "notDeepEqual",
            stackStartFn: notDeepEqual
        });
    }
}

function deepStrictEqual(
    actual: unknown,
    expected: unknown,
    message?: Message
) {
    if (arguments.length < 2) throw missingArgs();
    if (!isDeepStrictEqual(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "deepStrictEqual",
            stackStartFn: deepStrictEqual
        });
    }
}

function notDeepStrictEqual(
    actual: unknown,
    expected: unknown,
    message?: Message
) {
    if (arguments.length < 2) throw missingArgs();
    if (isDeepStrictEqual(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "notDeepStrictEqual",
            stackStartFn: notDeepStrictEqual
        });
    }
}

function strictEqual(actual: unknown, expected: unknown, message?: Message) {
    if (arguments.length < 2) throw missingArgs();
    if (!Object.is(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "strictEqual",
            stackStartFn: strictEqual
        });
    }
}

function notStrictEqual(actual: unknown, expected: unknown, message?: Message) {
    if (arguments.length < 2) throw missingArgs();
    if (Object.is(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "notStrictEqual",
            stackStartFn: notStrictEqual
        });
    }
}

function partialDeepStrictEqual(
    actual: unknown,
    expected: unknown,
    message?: Message
) {
    if (arguments.length < 2) throw missingArgs();
    if (!isPartialStrictEqual(actual, expected)) {
        innerFail({
            actual,
            expected,
            message,
            operator: "partialDeepStrictEqual",
            stackStartFn: partialDeepStrictEqual
        });
    }
}

// throws, rejects

const NO_EXCEPTION_SENTINEL = {};

// a validation object's view of an error, for the message
class Comparison {
    constructor(obj: any, keys: string[], actual?: any) {
        for (const key of keys) {
            if (key in obj) {
                if (
                    actual !== undefined &&
                    typeof actual[key] === "string" &&
                    isRegExp(obj[key]) &&
                    RegExp.prototype.exec.call(obj[key], actual[key]) !== null
                ) {
                    (this as any)[key] = actual[key];
                } else {
                    (this as any)[key] = obj[key];
                }
            }
        }
    }
}

function compareExceptionKey(
    actual: any,
    expected: any,
    key: string,
    message: Message,
    keys: string[],
    fn: Function,
    operator: string
) {
    if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
        if (!message) {
            const a = new Comparison(actual, keys);
            const b = new Comparison(expected, keys, actual);
            const err = new AssertionError({
                actual: a,
                expected: b,
                operator: "deepStrictEqual",
                stackStartFn: fn
            });
            err.actual = actual;
            err.expected = expected;
            err.operator = operator;
            throw err;
        }
        innerFail({ actual, expected, message, operator, stackStartFn: fn });
    }
}

function isError(value: unknown): value is Error {
    return isNativeError(value) || value instanceof Error;
}

function expectedException(
    actual: any,
    expected: any,
    message: Message,
    fn: Function,
    operator: string
) {
    let generatedMessage = false;
    let throwError = false;

    if (typeof expected !== "function") {
        if (isRegExp(expected)) {
            const str = String(actual);
            if (RegExp.prototype.exec.call(expected, str) !== null) return;
            if (!message) {
                generatedMessage = true;
                message = `The input did not match the regular expression ${inspect(
                    expected
                )}. Input:\n\n${inspect(str)}\n`;
            }
            throwError = true;
        } else if (typeof actual !== "object" || actual === null) {
            const err = new AssertionError({
                actual,
                expected,
                message,
                operator: "deepStrictEqual",
                stackStartFn: fn
            });
            err.operator = operator;
            throw err;
        } else {
            // a validation object
            const keys = Object.keys(expected);
            if (expected instanceof Error) {
                keys.push("name", "message");
            } else if (keys.length === 0) {
                throw invalidArgValue(
                    "error",
                    expected,
                    "may not be an empty object"
                );
            }
            for (const key of keys) {
                if (
                    typeof actual[key] === "string" &&
                    isRegExp(expected[key]) &&
                    RegExp.prototype.exec.call(expected[key], actual[key]) !==
                        null
                ) {
                    continue;
                }
                compareExceptionKey(
                    actual,
                    expected,
                    key,
                    message,
                    keys,
                    fn,
                    operator
                );
            }
            return;
        }
    } else if (expected.prototype !== undefined && actual instanceof expected) {
        return;
    } else if (Error.isPrototypeOf(expected)) {
        if (!message) {
            generatedMessage = true;
            message = `The error is expected to be an instance of "${expected.name}". Received `;
            if (isError(actual)) {
                const name = actual.constructor?.name || actual.name;
                if (expected.name === name) {
                    message +=
                        "an error with identical name but a different prototype.";
                } else {
                    message += `"${name}"`;
                }
                if (actual.message) {
                    message += `\n\nError message:\n\n${actual.message}`;
                }
            } else {
                message += `"${inspect(actual, { depth: -1 })}"`;
            }
        }
        throwError = true;
    } else {
        // a validation function
        const res = Reflect.apply(expected, {}, [actual]);
        if (res !== true) {
            if (!message) {
                generatedMessage = true;
                const name = expected.name ? `"${expected.name}" ` : "";
                message = `The ${name}validation function is expected to return "true". Received ${inspect(
                    res
                )}`;
                if (isError(actual)) {
                    message += `\n\nCaught error:\n\n${actual}`;
                }
            }
            throwError = true;
        }
    }

    if (throwError) {
        const err = new AssertionError({
            actual,
            expected,
            message,
            operator,
            stackStartFn: fn
        });
        err.generatedMessage = generatedMessage;
        throw err;
    }
}

function getActual(fn: unknown) {
    validateFunction(fn, "fn");
    try {
        (fn as AnyFunction)();
    } catch (e) {
        return e;
    }
    return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj: any) {
    return (
        isPromise(obj) ||
        (obj !== null &&
            typeof obj === "object" &&
            typeof obj.then === "function" &&
            typeof obj.catch === "function")
    );
}

async function waitForActual(promiseFn: unknown) {
    let resultPromise: unknown;
    if (typeof promiseFn === "function") {
        resultPromise = promiseFn();
        if (!checkIsPromise(resultPromise)) {
            throw nodeError(
                new TypeError(
                    `Expected instance of Promise to be returned from the "promiseFn" function but got ${
                        resultPromise === null
                            ? "null"
                            : typeof resultPromise === "object"
                              ? `instance of ${(resultPromise as object).constructor?.name ?? "Object"}`
                              : `type ${typeof resultPromise}`
                    }.`
                ),
                "ERR_INVALID_RETURN_VALUE"
            );
        }
    } else if (checkIsPromise(promiseFn)) {
        resultPromise = promiseFn;
    } else {
        throw invalidArgType(
            "promiseFn",
            "of type function or an instance of Promise",
            promiseFn
        );
    }
    try {
        await resultPromise;
    } catch (e) {
        return e;
    }
    return NO_EXCEPTION_SENTINEL;
}

function expectsError(
    stackStartFn: Function,
    operator: string,
    actual: unknown,
    error: any,
    message: Message,
    argCount: number
) {
    if (typeof error === "string") {
        if (argCount === 4) {
            throw invalidArgType(
                "error",
                "of type function or an instance of Error, RegExp, or Object",
                error
            );
        }
        if (typeof actual === "object" && actual !== null) {
            if ((actual as Error).message === error) {
                throw nodeError(
                    new TypeError(
                        `The "error/message" argument is ambiguous. The error message "${(actual as Error).message}" is identical to the message.`
                    ),
                    "ERR_AMBIGUOUS_ARGUMENT"
                );
            }
        } else if (actual === error) {
            throw nodeError(
                new TypeError(
                    `The "error/message" argument is ambiguous. The error "${actual}" is identical to the message.`
                ),
                "ERR_AMBIGUOUS_ARGUMENT"
            );
        }
        message = error;
        error = undefined;
    } else if (
        error != null &&
        typeof error !== "object" &&
        typeof error !== "function"
    ) {
        throw invalidArgType(
            "error",
            "of type function or an instance of Error, RegExp, or Object",
            error
        );
    }

    if (actual === NO_EXCEPTION_SENTINEL) {
        let details = "";
        if (error?.name) details += ` (${error.name})`;
        details += message ? `: ${message}` : ".";
        const fnType = operator === "rejects" ? "rejection" : "exception";
        innerFail({
            actual: undefined,
            expected: error,
            operator,
            message: `Missing expected ${fnType}${details}`,
            stackStartFn
        });
    }
    if (!error) return;
    expectedException(actual, error, message, stackStartFn, operator);
}

function hasMatchingError(actual: unknown, expected: any) {
    if (typeof expected !== "function") {
        if (isRegExp(expected)) {
            return (
                RegExp.prototype.exec.call(expected, String(actual)) !== null
            );
        }
        throw invalidArgType(
            "expected",
            "of type function or an instance of RegExp",
            expected
        );
    }
    if (expected.prototype !== undefined && actual instanceof expected) {
        return true;
    }
    if (Error.isPrototypeOf(expected)) return false;
    return Reflect.apply(expected, {}, [actual]) === true;
}

function expectsNoError(
    stackStartFn: Function,
    operator: string,
    actual: any,
    error: any,
    message: Message
) {
    if (actual === NO_EXCEPTION_SENTINEL) return;
    if (typeof error === "string") {
        message = error;
        error = undefined;
    }
    if (!error || hasMatchingError(actual, error)) {
        const details = message ? `: ${message}` : ".";
        const fnType = operator === "doesNotReject" ? "rejection" : "exception";
        innerFail({
            actual,
            expected: error,
            operator,
            message:
                `Got unwanted ${fnType}${details}\n` +
                `Actual message: "${actual?.message}"`,
            stackStartFn
        });
    }
    throw actual;
}

function throws(fn: () => unknown, error?: any, message?: Message) {
    expectsError(
        throws,
        "throws",
        getActual(fn),
        error,
        message,
        arguments.length
    );
}

async function rejects(
    promiseFn: Promise<unknown> | (() => Promise<unknown>),
    error?: any,
    message?: Message
) {
    expectsError(
        rejects,
        "rejects",
        await waitForActual(promiseFn),
        error,
        message,
        arguments.length
    );
}

function doesNotThrow(fn: () => unknown, error?: any, message?: Message) {
    expectsNoError(doesNotThrow, "doesNotThrow", getActual(fn), error, message);
}

async function doesNotReject(
    promiseFn: Promise<unknown> | (() => Promise<unknown>),
    error?: any,
    message?: Message
) {
    expectsNoError(
        doesNotReject,
        "doesNotReject",
        await waitForActual(promiseFn),
        error,
        message
    );
}

function ifError(err: unknown) {
    if (err !== null && err !== undefined) {
        let message = "ifError got unwanted exception: ";
        if (
            typeof err === "object" &&
            typeof (err as Error).message === "string"
        ) {
            if ((err as Error).message.length === 0 && err.constructor) {
                message += err.constructor.name;
            } else {
                message += (err as Error).message;
            }
        } else {
            message += inspect(err);
        }
        const newErr = new AssertionError({
            actual: err,
            expected: null,
            operator: "ifError",
            message,
            stackStartFn: ifError
        });
        // the stack of the original error follows the assertion's frames
        const origStack = (err as Error).stack;
        if (typeof origStack === "string" && typeof newErr.stack === "string") {
            const origFrames = origStack.split("\n");
            origFrames.shift();
            let newFrames = newErr.stack.split("\n");
            for (const frame of origFrames) {
                const pos = newFrames.indexOf(frame);
                if (pos !== -1) {
                    newFrames = newFrames.slice(0, pos);
                    break;
                }
            }
            const stackStart = newFrames.join("\n");
            const stackEnd = origFrames.join("\n");
            newErr.stack = `${stackStart}\n${stackEnd}`;
        }
        throw newErr;
    }
}

function internalMatch(
    string: unknown,
    regexp: RegExp,
    message: Message,
    fn: Function,
    operator: "match" | "doesNotMatch"
) {
    if (!isRegExp(regexp)) {
        throw invalidArgType("regexp", "an instance of RegExp", regexp);
    }
    const match = operator === "match";
    if (
        typeof string !== "string" ||
        (RegExp.prototype.exec.call(regexp, string) !== null) !== match
    ) {
        if (message instanceof Error) throw message;
        const generatedMessage = !message;
        message ||=
            typeof string !== "string"
                ? `The "string" argument must be of type string. Received type ${typeof string} (${inspect(
                      string
                  )})`
                : `${
                      match
                          ? "The input did not match the regular expression "
                          : "The input was expected to not match the regular expression "
                  }${inspect(regexp)}. Input:\n\n${inspect(string)}\n`;
        const err = new AssertionError({
            actual: string,
            expected: regexp,
            message,
            operator,
            stackStartFn: fn
        });
        err.generatedMessage = generatedMessage;
        throw err;
    }
}

function match(string: string, regexp: RegExp, message?: Message) {
    internalMatch(string, regexp, message, match, "match");
}

function doesNotMatch(string: string, regexp: RegExp, message?: Message) {
    internalMatch(string, regexp, message, doesNotMatch, "doesNotMatch");
}

// assert and assert.strict

function assert(value?: unknown, message?: Message): asserts value {
    innerOk(assert, arguments.length, value, message);
}

const methods = {
    fail,
    AssertionError,
    ok,
    equal,
    notEqual,
    deepEqual,
    notDeepEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    strictEqual,
    notStrictEqual,
    partialDeepStrictEqual,
    throws,
    rejects,
    doesNotThrow,
    doesNotReject,
    ifError,
    match,
    doesNotMatch
};
Object.assign(assert, methods);

function strict(value?: unknown, message?: Message): asserts value {
    innerOk(strict, arguments.length, value, message);
}

Object.assign(strict, methods, {
    equal: strictEqual,
    deepEqual: deepStrictEqual,
    notEqual: notStrictEqual,
    notDeepEqual: notDeepStrictEqual
});
(assert as any).strict = strict;
(strict as any).strict = strict;

// typed as Node's for the importers of this file
const Exported = assert as unknown as typeof NodeAssert;
const ExportedStrict = strict as unknown as typeof NodeAssert.strict;

export {
    Exported as default,
    Exported as "module.exports",
    ExportedStrict as strict,
    AssertionError,
    fail,
    ok,
    equal,
    notEqual,
    deepEqual,
    notDeepEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    strictEqual,
    notStrictEqual,
    partialDeepStrictEqual,
    throws,
    rejects,
    doesNotThrow,
    doesNotReject,
    ifError,
    match,
    doesNotMatch
};
