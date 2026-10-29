// util.inspect and util.format (Node 24, the version test/shim compares
// with), improvements/shim/plan.md 5.4.
//
// The structure is Node's lib/internal/util/inspect.js: formatValue,
// formatRaw, the per-type formatters and reduceToSingleString with its
// compact / breakLength rules and array grouping, so that the output matches
// Node's byte for byte where JavaScript can see the same things.
//
// What a page cannot see, and prints instead:
// - the state of a Promise: `Promise { <unknown> }` (Node: `Promise { 1 }`,
//   `Promise { <pending> }`, `Promise { <rejected> ... }`);
// - the entries of Map/Set iterators and of WeakMap/WeakSet:
//   `[Map Iterator] { <items unknown> }`, `WeakMap { <items unknown> }`;
// - Proxies (printed as their target, `showProxy` is ignored);
// - the class name of objects without a constructor in their prototype
//   chain, which V8 reads from the object map: the toString tag is used;
// - collapsing of repeated frames in long stacks (only the frames shared
//   with an error's cause are collapsed).
// Stacks from JavaScriptCore and Gecko (`fn@url:line:col`, no header) are
// given V8's shape (`Name: message\n    at fn@url:line:col`).

import {
    isAnyArrayBuffer,
    isArgumentsObject,
    isArrayBuffer,
    isAsyncFunction,
    isBigIntObject,
    isBooleanObject,
    isBoxedPrimitive,
    isDataView,
    isDate,
    isGeneratorFunction,
    isMap,
    isMapIterator,
    isModuleNamespaceObject,
    isNativeError,
    isNumberObject,
    isPromise,
    isRegExp,
    isSet,
    isSetIterator,
    isStringObject,
    isTypedArray,
    isWeakMap,
    isWeakSet
} from "./types.ts";
import {
    hasOwn,
    invalidArgType,
    isEnumerable,
    isIndex,
    isURL,
    objectToString,
    typedArrayKind,
    validateObject
} from "./internal.ts";

export interface InspectOptions {
    showHidden?: boolean;
    depth?: number | null;
    colors?: boolean;
    customInspect?: boolean;
    showProxy?: boolean;
    maxArrayLength?: number | null;
    maxStringLength?: number | null;
    breakLength?: number;
    compact?: boolean | number;
    sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | "get" | "set";
    numericSeparator?: boolean;
    stylize?: (text: string, styleType: string) => string;
    [key: string]: unknown;
}

type Stylize = (text: string, styleType: string) => string;

interface Context {
    budget: Record<number, number>;
    indentationLvl: number;
    seen: unknown[];
    currentDepth: number;
    stylize: Stylize;
    showHidden: boolean;
    depth: number;
    colors: boolean;
    customInspect: boolean;
    showProxy: boolean;
    maxArrayLength: number;
    maxStringLength: number;
    breakLength: number;
    compact: boolean | number;
    sorted: boolean | ((a: string, b: string) => number);
    getters: boolean | "get" | "set";
    numericSeparator: boolean;
    circular?: Map<unknown, number>;
    userOptions?: InspectOptions;
}

type Formatter = (ctx: Context, value: any, recurseTimes: number) => string[];

const inspectDefaultOptions = Object.seal({
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3 as boolean | number,
    sorted: false as Context["sorted"],
    getters: false as Context["getters"],
    numericSeparator: false
});

const kObjectType = 0;
const kArrayType = 1;
const kArrayExtrasType = 2;

const kMinLineWidth = 16;

const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get as (
    this: unknown
) => number;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get as (
    this: unknown
) => number;

// colors and styles

// name, open code, close code, in Node's order
const colors: Record<string, [number, number]> = Object.create(null);
for (const entry of (
    "reset 0 0,bold 1 22,dim 2 22,italic 3 23,underline 4 24,blink 5 25," +
    "inverse 7 27,hidden 8 28,strikethrough 9 29,doubleunderline 21 24," +
    "black 30 39,red 31 39,green 32 39,yellow 33 39,blue 34 39," +
    "magenta 35 39,cyan 36 39,white 37 39,bgBlack 40 49,bgRed 41 49," +
    "bgGreen 42 49,bgYellow 43 49,bgBlue 44 49,bgMagenta 45 49," +
    "bgCyan 46 49,bgWhite 47 49,framed 51 54,overlined 53 55,gray 90 39," +
    "redBright 91 39,greenBright 92 39,yellowBright 93 39," +
    "blueBright 94 39,magentaBright 95 39,cyanBright 96 39," +
    "whiteBright 97 39,bgGray 100 49,bgRedBright 101 49," +
    "bgGreenBright 102 49,bgYellowBright 103 49,bgBlueBright 104 49," +
    "bgMagentaBright 105 49,bgCyanBright 106 49,bgWhiteBright 107 49"
).split(",")) {
    const [name, open, close] = entry.split(" ");
    colors[name] = [+open, +close];
}

// Node's aliases (alias color): non-enumerable accessors to the color
for (const entry of (
    "grey gray,blackBright gray,bgGrey bgGray,bgBlackBright bgGray," +
    "faint dim,crossedout strikethrough,strikeThrough strikethrough," +
    "crossedOut strikethrough,conceal hidden,swapColors inverse," +
    "swapcolors inverse,doubleUnderline doubleunderline"
).split(",")) {
    const [alias, target] = entry.split(" ");
    Object.defineProperty(colors, alias, {
        get() {
            return this[target];
        },
        set(value) {
            Object.defineProperty(this, alias, {
                value,
                configurable: true,
                writable: true,
                enumerable: true
            });
        },
        configurable: true,
        enumerable: false
    });
}

const styles: Record<string, string> = Object.assign(Object.create(null), {
    special: "cyan",
    number: "yellow",
    bigint: "yellow",
    boolean: "yellow",
    undefined: "grey",
    null: "bold",
    string: "green",
    symbol: "green",
    date: "magenta",
    regexp: "red",
    module: "underline"
});

function stylizeWithColor(str: string, styleType: string) {
    const style = styles[styleType];
    if (style !== undefined) {
        const color = colors[style];
        if (color !== undefined) {
            return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
        }
    }
    return str;
}

function stylizeNoColor(str: string) {
    return str;
}

const colorRegExp = /\u001b\[\d\d?m/g;
const removeColors = (str: string) => str.replace(colorRegExp, "");

// strings

// the characters inspect escapes in strings: control characters, the
// backslash, the single quote (not in the "Single" variants, for strings
// shown in other quotes) and lone surrogates (in unicode mode a pair is one
// character, so the surrogate range only matches lone ones; no lookbehind,
// which WebKit before 16.4 cannot parse)
const escaped = "[\\x00-\\x1f\\x27\\x5c\\x7f-\\x9f\\ud800-\\udfff]";
const escapedSingle = "[\\x00-\\x1f\\x5c\\x7f-\\x9f\\ud800-\\udfff]";
const strEscapeSequencesRegExp = new RegExp(escaped, "u");
const strEscapeSequencesReplacer = new RegExp(escaped, "gu");
const strEscapeSequencesRegExpSingle = new RegExp(escapedSingle, "u");
const strEscapeSequencesReplacerSingle = new RegExp(escapedSingle, "gu");
const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const numberRegExp = /^(0|[1-9][0-9]*)$/;

// the escape of each code unit below 0xa0, '' for the ones kept as is
const meta: string[] = [];
for (let i = 0; i < 0xa0; i++) {
    const hex = i.toString(16).toUpperCase().padStart(2, "0");
    meta.push(i < 0x20 || i >= 0x7f ? `\\x${hex}` : "");
}
meta[8] = "\\b";
meta[9] = "\\t";
meta[10] = "\\n";
meta[12] = "\\f";
meta[13] = "\\r";
meta[39] = "\\'";
meta[92] = "\\\\";

function escapeFn(str: string) {
    const code = str.charCodeAt(0);
    return code < meta.length ? meta[code] : `\\u${code.toString(16)}`;
}

function addQuotes(str: string, quotes: number) {
    if (quotes === -1) return `"${str}"`;
    if (quotes === -2) return `\`${str}\``;
    return `'${str}'`;
}

// Node's quote selection: single quotes, double when the string holds a
// single quote, backticks when it holds both
export function strEscape(str: string) {
    let escapeTest = strEscapeSequencesRegExp;
    let escapeReplace = strEscapeSequencesReplacer;
    let singleQuote = 39;
    if (str.includes("'")) {
        if (!str.includes('"')) {
            singleQuote = -1;
        } else if (!str.includes("`") && !str.includes("${")) {
            singleQuote = -2;
        }
        if (singleQuote !== 39) {
            escapeTest = strEscapeSequencesRegExpSingle;
            escapeReplace = strEscapeSequencesReplacerSingle;
        }
    }
    if (!escapeTest.test(str)) return addQuotes(str, singleQuote);
    return addQuotes(str.replace(escapeReplace, escapeFn), singleQuote);
}

// numbers

function addNumericSeparator(integerString: string) {
    let result = "";
    let i = integerString.length;
    const start = integerString.startsWith("-") ? 1 : 0;
    for (; i >= start + 4; i -= 3) {
        result = `_${integerString.slice(i - 3, i)}${result}`;
    }
    return i === integerString.length
        ? integerString
        : `${integerString.slice(0, i)}${result}`;
}

function addNumericSeparatorEnd(integerString: string) {
    let result = "";
    let i = 0;
    for (; i < integerString.length - 3; i += 3) {
        result += `${integerString.slice(i, i + 3)}_`;
    }
    return i === 0 ? integerString : `${result}${integerString.slice(i)}`;
}

export function formatNumber(
    fn: Stylize,
    number: number,
    numericSeparator: boolean
) {
    if (!numericSeparator) {
        if (Object.is(number, -0)) return fn("-0", "number");
        return fn(`${number}`, "number");
    }
    const numberString = String(number);
    if (Math.trunc(number) === number) {
        if (!Number.isFinite(number) || numberString.includes("e")) {
            return fn(numberString, "number");
        }
        return fn(addNumericSeparator(numberString), "number");
    }
    if (Number.isNaN(number)) return fn(numberString, "number");
    const decimalIndex = numberString.indexOf(".");
    return fn(
        `${addNumericSeparator(numberString.slice(0, decimalIndex))}.${addNumericSeparatorEnd(
            numberString.slice(decimalIndex + 1)
        )}`,
        "number"
    );
}

export function formatBigInt(
    fn: Stylize,
    bigint: bigint,
    numericSeparator: boolean
) {
    const string = String(bigint);
    if (!numericSeparator) return fn(`${string}n`, "bigint");
    return fn(`${addNumericSeparator(string)}n`, "bigint");
}

function formatPrimitive(fn: Stylize, value: unknown, ctx: Context): string {
    if (typeof value === "string") {
        let trailer = "";
        if (value.length > ctx.maxStringLength) {
            const remaining = value.length - ctx.maxStringLength;
            value = value.slice(0, ctx.maxStringLength);
            trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`;
        }
        const str = value as string;
        if (
            ctx.compact !== true &&
            str.length > kMinLineWidth &&
            str.length > ctx.breakLength - ctx.indentationLvl - 4
        ) {
            return (
                str
                    .match(/[^\n]*\n|[^\n]+/g)
                    .map((line) => fn(strEscape(line), "string"))
                    .join(` +\n${" ".repeat(ctx.indentationLvl + 2)}`) + trailer
            );
        }
        return fn(strEscape(str), "string") + trailer;
    }
    if (typeof value === "number") {
        return formatNumber(fn, value, ctx.numericSeparator);
    }
    if (typeof value === "bigint") {
        return formatBigInt(fn, value, ctx.numericSeparator);
    }
    if (typeof value === "boolean") return fn(`${value}`, "boolean");
    if (typeof value === "undefined") return fn("undefined", "undefined");
    return fn((value as symbol).toString(), "symbol");
}

// the entry point

function inspect(value: unknown, opts?: boolean | InspectOptions): string {
    const ctx: Context = {
        budget: {},
        indentationLvl: 0,
        seen: [],
        currentDepth: 0,
        stylize: stylizeNoColor,
        ...inspectDefaultOptions
    };
    if (arguments.length > 1) {
        // legacy: inspect(value, showHidden, depth, colors)
        if (arguments.length > 2) {
            if (arguments[2] !== undefined) ctx.depth = arguments[2];
            if (arguments.length > 3 && arguments[3] !== undefined) {
                ctx.colors = arguments[3];
            }
        }
        if (typeof opts === "boolean") {
            ctx.showHidden = opts;
        } else if (opts) {
            for (const key of Object.keys(opts)) {
                if (hasOwn(inspectDefaultOptions, key) || key === "stylize") {
                    (ctx as any)[key] = opts[key];
                } else if (ctx.userOptions === undefined) {
                    ctx.userOptions = opts;
                }
            }
        }
    }
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
}

inspect.custom = customInspectSymbol as typeof customInspectSymbol;
inspect.colors = colors;
inspect.styles = styles;
Object.defineProperty(inspect, "defaultOptions", {
    get() {
        return inspectDefaultOptions;
    },
    set(options) {
        validateObject(options, "options");
        Object.assign(inspectDefaultOptions, options);
    }
});

const optionNames = Object.keys(inspectDefaultOptions);

// what a custom inspect function gets as options
function getUserOptions(ctx: Context): InspectOptions {
    const options: InspectOptions = { stylize: ctx.stylize };
    for (const name of optionNames) options[name] = (ctx as any)[name];
    return { ...options, ...ctx.userOptions };
}

function formatValue(
    ctx: Context,
    value: any,
    recurseTimes: number,
    typedArray?: boolean
): string {
    if (typeof value !== "object" && typeof value !== "function") {
        return formatPrimitive(ctx.stylize, value, ctx);
    }
    if (value === null) return ctx.stylize("null", "null");

    if (ctx.customInspect) {
        const maybeCustom = value[customInspectSymbol];
        if (
            typeof maybeCustom === "function" &&
            maybeCustom !== inspect &&
            Object.getOwnPropertyDescriptor(value, "constructor")?.value
                ?.prototype !== value
        ) {
            const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
            const ret = maybeCustom.call(
                value,
                depth,
                getUserOptions(ctx),
                inspect
            );
            if (ret !== value) {
                if (typeof ret !== "string") {
                    return formatValue(ctx, ret, recurseTimes);
                }
                return ret.replaceAll(
                    "\n",
                    `\n${" ".repeat(ctx.indentationLvl)}`
                );
            }
        }
    }

    if (ctx.seen.includes(value)) {
        let index = 1;
        if (ctx.circular === undefined) {
            ctx.circular = new Map();
            ctx.circular.set(value, index);
        } else {
            index = ctx.circular.get(value);
            if (index === undefined) {
                index = ctx.circular.size + 1;
                ctx.circular.set(value, index);
            }
        }
        return ctx.stylize(`[Circular *${index}]`, "special");
    }

    return formatRaw(ctx, value, recurseTimes, typedArray);
}

function isInstanceof(object: unknown, ctor: Function) {
    try {
        return object instanceof ctor;
    } catch {
        return false;
    }
}

// the built-in prototypes whose `constructor` may have been tampered with
const wellKnownPrototypes = new Map<object, Function>();
for (const ctor of [
    Array,
    ArrayBuffer,
    Function,
    Map,
    Set,
    Object,
    Object.getPrototypeOf(Uint8Array),
    RegExp,
    Date,
    DataView,
    Error,
    (globalThis as any).AggregateError,
    RangeError,
    TypeError,
    Boolean,
    Number,
    String,
    Promise,
    WeakMap,
    WeakSet
]) {
    if (ctor) wellKnownPrototypes.set(ctor.prototype, ctor);
}

function getConstructorName(
    obj: object,
    ctx: Context,
    recurseTimes: number
): string | null {
    let firstProto: object | null | undefined;
    const tmp = obj;
    while (obj) {
        const wellKnown = wellKnownPrototypes.get(obj);
        if (wellKnown !== undefined && isInstanceof(tmp, wellKnown)) {
            return wellKnown.name;
        }
        const descriptor = Object.getOwnPropertyDescriptor(obj, "constructor");
        if (
            descriptor !== undefined &&
            typeof descriptor.value === "function" &&
            descriptor.value.name !== "" &&
            isInstanceof(tmp, descriptor.value)
        ) {
            return String(descriptor.value.name);
        }
        obj = Object.getPrototypeOf(obj);
        if (firstProto === undefined) firstProto = obj;
    }
    if (firstProto === null) return null;

    const res = internalGetConstructorName(tmp);
    if (recurseTimes > ctx.depth && ctx.depth !== null) {
        return `${res} <Complex prototype>`;
    }
    const protoConstr = getConstructorName(firstProto, ctx, recurseTimes + 1);
    if (protoConstr === null) {
        return `${res} <${inspect(firstProto, {
            ...ctx,
            customInspect: false,
            depth: -1
        } as InspectOptions)}>`;
    }
    return `${res} <${protoConstr}>`;
}

// V8 reads the class name from the object map; a page has the toString tag
function internalGetConstructorName(value: object) {
    return objectToString.call(value).slice(8, -1);
}

function getPrefix(
    constructor: string | null,
    tag: string,
    fallback: string,
    size = ""
) {
    if (constructor === null) {
        if (tag !== "" && fallback !== tag) {
            return `[${fallback}${size}: null prototype] [${tag}] `;
        }
        return `[${fallback}${size}: null prototype] `;
    }
    let result = `${constructor}${size} `;
    // the tag is left out when the constructor name has it as a word
    // (MySet, not Foo, for a Set)
    if (tag !== "") {
        const position = constructor.indexOf(tag);
        const endPos = position + tag.length;
        if (
            position === -1 ||
            (endPos !== constructor.length &&
                constructor[endPos] === constructor[endPos].toLowerCase())
        ) {
            result += `[${tag}] `;
        }
    }
    return result;
}

function getCtxStyle(value: object, constructor: string | null, tag: string) {
    let fallback = "";
    if (constructor === null) {
        fallback = internalGetConstructorName(value);
        if (fallback === tag) fallback = "Object";
    }
    return getPrefix(constructor, tag, fallback);
}

function getKeys(value: object, showHidden: boolean): PropertyKey[] {
    let keys: PropertyKey[];
    const symbols = Object.getOwnPropertySymbols(value);
    if (showHidden) {
        keys = Object.getOwnPropertyNames(value);
        if (symbols.length !== 0) keys.push(...symbols);
    } else {
        keys = Object.keys(value);
        if (symbols.length !== 0) {
            for (const symbol of symbols) {
                if (isEnumerable(value, symbol)) keys.push(symbol);
            }
        }
    }
    return keys;
}

// the own keys of an array or typed array that are not indices
export function getOwnNonIndexProperties(
    value: object,
    onlyEnumerable: boolean,
    skipSymbols = false
): PropertyKey[] {
    const keys: PropertyKey[] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
        if (isIndex(key)) continue;
        if (onlyEnumerable && !isEnumerable(value, key)) continue;
        keys.push(key);
    }
    if (!skipSymbols) {
        for (const symbol of Object.getOwnPropertySymbols(value)) {
            if (onlyEnumerable && !isEnumerable(value, symbol)) continue;
            keys.push(symbol);
        }
    }
    return keys;
}

// keys of an array: Object.keys lists the indices first, a dense array
// without extra keys is the common case and skips the scan
function getArrayExtraKeys(value: unknown[], showHidden: boolean) {
    if (!showHidden) {
        const keys = Object.keys(value);
        let extras: PropertyKey[] | undefined;
        if (keys.length !== value.length || keys.length === 0) {
            for (const key of keys) {
                if (!isIndex(key)) (extras ??= []).push(key);
            }
        } else if (!isIndex(keys[keys.length - 1])) {
            extras = getOwnNonIndexProperties(value, true, true);
        }
        extras ??= [];
        for (const symbol of Object.getOwnPropertySymbols(value)) {
            if (isEnumerable(value, symbol)) extras.push(symbol);
        }
        return extras;
    }
    return getOwnNonIndexProperties(value, false);
}

function getFunctionBase(
    ctx: Context,
    value: Function,
    constructor: string | null,
    tag: string
) {
    let stringified = "";
    try {
        stringified = Function.prototype.toString.call(value);
    } catch {}
    if (stringified.startsWith("class") && stringified.endsWith("}")) {
        const slice = stringified.slice(5, -1);
        const bracketIndex = slice.indexOf("{");
        if (
            bracketIndex !== -1 &&
            (!slice.slice(0, bracketIndex).includes("(") ||
                /^\s*(?:extends\s+)?[^(]*?\{/.test(
                    slice.replace(/(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g, "")
                ))
        ) {
            return getClassBase(value, constructor, tag);
        }
    }
    let type = "Function";
    if (isGeneratorFunction(value)) type = `Generator${type}`;
    if (isAsyncFunction(value)) type = `Async${type}`;
    let base = `[${type}`;
    if (constructor === null) base += " (null prototype)";
    if (value.name === "") {
        base += " (anonymous)";
    } else {
        base += `: ${typeof value.name === "string" ? value.name : formatValue(ctx, value.name, 0)}`;
    }
    base += "]";
    if (constructor !== type && constructor !== null) {
        base += ` ${constructor}`;
    }
    if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
    return base;
}

function getClassBase(value: any, constructor: string | null, tag: string) {
    const name = (hasOwn(value, "name") && value.name) || "(anonymous)";
    let base = `class ${name}`;
    if (constructor !== "Function" && constructor !== null) {
        base += ` [${constructor}]`;
    }
    if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
    if (constructor !== null) {
        const superName = Object.getPrototypeOf(value).name;
        if (superName) base += ` extends ${superName}`;
    } else {
        base += " extends [null prototype]";
    }
    return `[${base}]`;
}

function getBoxedBase(
    value: any,
    ctx: Context,
    keys: PropertyKey[],
    constructor: string | null,
    tag: string
) {
    let type: string;
    let primitive: unknown;
    if (isNumberObject(value)) {
        type = "Number";
        primitive = Number.prototype.valueOf.call(value);
    } else if (isStringObject(value)) {
        type = "String";
        primitive = String.prototype.valueOf.call(value);
        // the indices of a boxed string are its characters, already shown
        keys.splice(0, (primitive as string).length);
    } else if (isBooleanObject(value)) {
        type = "Boolean";
        primitive = Boolean.prototype.valueOf.call(value);
    } else if (isBigIntObject(value)) {
        type = "BigInt";
        primitive = BigInt.prototype.valueOf.call(value);
    } else {
        type = "Symbol";
        primitive = Symbol.prototype.valueOf.call(value);
    }
    let base = `[${type}`;
    if (type !== constructor) {
        if (constructor === null) base += " (null prototype)";
        else base += ` (${constructor})`;
    }
    base += `: ${formatPrimitive(stylizeNoColor, primitive, ctx)}]`;
    if (tag !== "" && tag !== constructor) base += ` [${tag}]`;
    if (keys.length !== 0 || ctx.stylize === stylizeNoColor) return base;
    return ctx.stylize(base, type.toLowerCase());
}

// V8 stacks start with "Name: message" and list "    at" frames;
// JavaScriptCore and Gecko only list "fn@url:line:col" frames
function getStackString(ctx: Context, error: any): string {
    let stack: unknown;
    try {
        stack = error.stack;
    } catch {}
    if (!stack) return Error.prototype.toString.call(error);
    if (typeof stack !== "string") {
        ctx.seen.push(error);
        ctx.indentationLvl += 4;
        const result = formatValue(ctx, stack, 0);
        ctx.indentationLvl -= 4;
        ctx.seen.pop();
        return `${Error.prototype.toString.call(error)}\n    ${result}`;
    }
    if (stack.includes("\n    at ") || !/@|^\[native code\]$/m.test(stack)) {
        return stack;
    }
    const lines = stack.split("\n").filter((line) => line !== "");
    if (!lines.every((line) => /@|^\[native code\]$/.test(line))) {
        return stack;
    }
    return `${Error.prototype.toString.call(error)}\n${lines
        .map((line) => `    at ${line}`)
        .join("\n")}`;
}

function improveStack(
    stack: string,
    constructor: string | null,
    name: any,
    tag: string
) {
    let len = name.length;
    if (typeof name !== "string") {
        stack = stack.replace(
            `${name}`,
            `${name} [${getPrefix(constructor, tag, "Error").slice(0, -1)}]`
        );
    }
    if (
        constructor === null ||
        (name.endsWith("Error") &&
            stack.startsWith(name) &&
            (stack.length === len || stack[len] === ":" || stack[len] === "\n"))
    ) {
        let fallback = "Error";
        if (constructor === null) {
            const start =
                /^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/.exec(stack) ||
                /^([a-z_A-Z0-9-]*Error)$/.exec(stack);
            fallback = start?.[1] || "";
            len = fallback.length;
            fallback ||= "Error";
        }
        const prefix = getPrefix(constructor, tag, fallback).slice(0, -1);
        if (name !== prefix) {
            if (prefix.includes(name)) {
                if (len === 0) stack = `${prefix}: ${stack}`;
                else stack = `${prefix}${stack.slice(len)}`;
            } else {
                stack = `${prefix} [${name}]${stack.slice(len)}`;
            }
        }
    }
    return stack;
}

// the frames an error shares with its cause are collapsed
function getStackFrames(ctx: Context, err: any, stack: string) {
    const frames = stack.split("\n");
    let cause: unknown;
    try {
        cause = err.cause;
    } catch {}
    if (cause != null && (isNativeError(cause) || cause instanceof Error)) {
        const causeStack = getStackString(ctx, cause);
        const causeStackStart = causeStack.indexOf("\n    at");
        if (causeStackStart !== -1) {
            const causeFrames = causeStack
                .slice(causeStackStart + 1)
                .split("\n");
            const { len, offset } = identicalSequenceRange(frames, causeFrames);
            if (len > 0) {
                const skipped = len - 2;
                const msg = `    ... ${skipped} lines matching cause stack trace ...`;
                frames.splice(
                    offset + 1,
                    skipped,
                    ctx.stylize(msg, "undefined")
                );
            }
        }
    }
    return frames;
}

function identicalSequenceRange(a: string[], b: string[]) {
    for (let i = 0; i < a.length - 3; i++) {
        const pos = b.indexOf(a[i]);
        if (pos !== -1) {
            const rest = b.length - pos;
            if (rest > 3) {
                let len = 1;
                const maxLen = Math.min(a.length - i, rest);
                while (maxLen > len && a[i + len] === b[pos + len]) len++;
                if (len > 3) return { len, offset: i };
            }
        }
    }
    return { len: 0, offset: 0 };
}

// a getter that throws is read as missing
function read(object: any, key: string) {
    try {
        return { value: object[key] };
    } catch {
        return undefined;
    }
}

function formatError(
    err: any,
    constructor: string | null,
    tag: string,
    ctx: Context,
    keys: PropertyKey[]
) {
    let stack: string;
    try {
        stack = getStackString(ctx, err);
    } catch {
        return objectToString.call(err);
    }
    const message = read(err, "message");
    const nameRead = read(err, "name");
    if (!ctx.showHidden && keys.length !== 0) {
        const index = keys.indexOf("stack");
        if (index !== -1) keys.splice(index, 1);
        // name and message are hidden when the stack shows them
        for (const [key, got] of [
            ["message", message],
            ["name", nameRead]
        ] as const) {
            const index = keys.indexOf(key);
            if (
                got !== undefined &&
                index !== -1 &&
                (typeof got.value !== "string" || stack.includes(got.value))
            ) {
                keys.splice(index, 1);
            }
        }
    }
    const name = nameRead?.value ?? "Error";
    if (
        hasOwn(err, "cause") &&
        (keys.length === 0 || !keys.includes("cause"))
    ) {
        keys.push("cause");
    }
    const errors = read(err, "errors")?.value;
    if (
        Array.isArray(errors) &&
        hasOwn(err, "errors") &&
        (keys.length === 0 || !keys.includes("errors"))
    ) {
        keys.push("errors");
    }
    stack = improveStack(stack, constructor, name, tag);

    // the message is part of the stack: look for the frames after it
    const text = message?.value;
    let pos = (text && stack.indexOf(text)) || -1;
    if (pos !== -1) pos += text.length;
    const stackStart = stack.indexOf("\n    at", pos);
    if (stackStart === -1) {
        stack = `[${stack}]`;
    } else {
        let lines = getStackFrames(ctx, err, stack.slice(stackStart + 1));
        if (ctx.colors) {
            lines = lines.map((line) =>
                line.includes("node_modules") || line.includes("(node:")
                    ? ctx.stylize(line, "undefined")
                    : line
            );
        }
        stack = `${stack.slice(0, stackStart)}\n${lines.join("\n")}`;
    }
    if (ctx.indentationLvl !== 0) {
        stack = stack.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
    }
    return stack;
}

function formatRaw(
    ctx: Context,
    value: any,
    recurseTimes: number,
    typedArray?: boolean
): string {
    let keys: PropertyKey[];
    const constructor = getConstructorName(value, ctx, recurseTimes);
    let tag: string = "";
    try {
        tag = value[Symbol.toStringTag];
    } catch {}
    if (
        typeof tag !== "string" ||
        (tag !== "" &&
            (ctx.showHidden ? hasOwn : isEnumerable)(value, Symbol.toStringTag))
    ) {
        tag = "";
    }
    let base = "";
    let formatter: Formatter = getEmptyFormatArray;
    let braces: [string, string];
    let noIterator = true;
    let extrasType = kObjectType;
    // keys read from the object itself, shown as [key]
    let extraKeys: string[] | undefined;

    if (Symbol.iterator in value || constructor === null) {
        noIterator = false;
        if (Array.isArray(value)) {
            const prefix =
                constructor !== "Array" || tag !== ""
                    ? getPrefix(constructor, tag, "Array", `(${value.length})`)
                    : "";
            keys = getArrayExtraKeys(value, ctx.showHidden);
            braces = [`${prefix}[`, "]"];
            if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
            extrasType = kArrayExtrasType;
            formatter = formatArray;
        } else if (isSet(value)) {
            const size = setSize.call(value);
            const prefix = getPrefix(constructor, tag, "Set", `(${size})`);
            keys = getKeys(value, ctx.showHidden);
            formatter = formatSetOrMap;
            if (size === 0 && keys.length === 0) return `${prefix}{}`;
            braces = [`${prefix}{`, "}"];
        } else if (isMap(value)) {
            const size = mapSize.call(value);
            const prefix = getPrefix(constructor, tag, "Map", `(${size})`);
            keys = getKeys(value, ctx.showHidden);
            formatter = formatSetOrMap;
            if (size === 0 && keys.length === 0) return `${prefix}{}`;
            braces = [`${prefix}{`, "}"];
        } else if (isTypedArray(value)) {
            keys = getOwnNonIndexProperties(value, !ctx.showHidden);
            const fallback =
                constructor === null ? typedArrayKind.call(value) : "";
            const size = value.length;
            const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
            braces = [`${prefix}[`, "]"];
            if (value.length === 0 && keys.length === 0 && !ctx.showHidden) {
                return `${braces[0]}]`;
            }
            formatter = formatTypedArray;
            extrasType = kArrayExtrasType;
            if (ctx.showHidden) {
                extraKeys = [
                    "BYTES_PER_ELEMENT",
                    "length",
                    "byteLength",
                    "byteOffset",
                    "buffer"
                ];
                typedArray = true;
            }
        } else if (isMapIterator(value) || isSetIterator(value)) {
            keys = getKeys(value, ctx.showHidden);
            const type = `${isMapIterator(value) ? "Map" : "Set"} Iterator`;
            braces = [
                `[${tag === type ? tag : `${tag ? `${tag}] [` : ""}${type}`}] {`,
                "}"
            ];
            formatter = formatUnknownItems;
        } else {
            noIterator = true;
        }
    }
    if (noIterator) {
        keys = getKeys(value, ctx.showHidden);
        braces = ["{", "}"];
        if (typeof value === "function") {
            base = getFunctionBase(ctx, value, constructor, tag);
            if (keys.length === 0) return ctx.stylize(base, "special");
        } else if (constructor === "Object") {
            if (isArgumentsObject(value)) {
                braces[0] = "[Arguments] {";
            } else if (tag !== "") {
                braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
            }
            if (keys.length === 0) return `${braces[0]}}`;
        } else if (isRegExp(value)) {
            base = RegExp.prototype.toString.call(
                constructor !== null ? value : new RegExp(value)
            );
            const prefix = getPrefix(constructor, tag, "RegExp");
            if (prefix !== "RegExp ") base = `${prefix}${base}`;
            if (
                keys.length === 0 ||
                (recurseTimes > ctx.depth && ctx.depth !== null)
            ) {
                return ctx.stylize(base, "regexp");
            }
        } else if (isDate(value)) {
            base = Number.isNaN(Date.prototype.getTime.call(value))
                ? Date.prototype.toString.call(value)
                : Date.prototype.toISOString.call(value);
            const prefix = getPrefix(constructor, tag, "Date");
            if (prefix !== "Date ") base = `${prefix}${base}`;
            if (keys.length === 0) return ctx.stylize(base, "date");
        } else if (isNativeError(value) || value instanceof Error) {
            base = formatError(value, constructor, tag, ctx, keys);
            if (keys.length === 0) return base;
        } else if (isAnyArrayBuffer(value)) {
            const arrayType = isArrayBuffer(value)
                ? "ArrayBuffer"
                : "SharedArrayBuffer";
            const prefix = getPrefix(constructor, tag, arrayType);
            if (typedArray === undefined) {
                formatter = formatArrayBuffer;
            } else if (keys.length === 0) {
                return `${prefix}{ [byteLength]: ${formatNumber(
                    ctx.stylize,
                    value.byteLength,
                    false
                )} }`;
            }
            braces[0] = `${prefix}{`;
            extraKeys = ["byteLength"];
        } else if (isDataView(value)) {
            braces[0] = `${getPrefix(constructor, tag, "DataView")}{`;
            extraKeys = ["byteLength", "byteOffset", "buffer"];
        } else if (isPromise(value)) {
            braces[0] = `${getPrefix(constructor, tag, "Promise")}{`;
            formatter = formatPromise;
        } else if (isWeakSet(value)) {
            braces[0] = `${getPrefix(constructor, tag, "WeakSet")}{`;
            formatter = formatUnknownItems;
        } else if (isWeakMap(value)) {
            braces[0] = `${getPrefix(constructor, tag, "WeakMap")}{`;
            formatter = formatUnknownItems;
        } else if (isModuleNamespaceObject(value)) {
            braces[0] = `${getPrefix(constructor, tag, "Module")}{`;
        } else if (isBoxedPrimitive(value)) {
            base = getBoxedBase(value, ctx, keys, constructor, tag);
            if (keys.length === 0) return base;
        } else if (
            isURL(value) &&
            !(recurseTimes > ctx.depth && ctx.depth !== null)
        ) {
            // a URL (the page's own has no inspect.custom) shows its href
            base = value.href;
            if (keys.length === 0) return base;
        } else {
            if (keys.length === 0) {
                return `${getCtxStyle(value, constructor, tag)}{}`;
            }
            braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
        }
    }

    if (recurseTimes > ctx.depth && ctx.depth !== null) {
        let constructorName = getCtxStyle(value, constructor, tag).slice(0, -1);
        if (constructor !== null) constructorName = `[${constructorName}]`;
        return ctx.stylize(constructorName, "special");
    }
    recurseTimes += 1;
    ctx.seen.push(value);
    ctx.currentDepth = recurseTimes;
    let output: string[];
    const indentationLvl = ctx.indentationLvl;
    try {
        output = formatter(ctx, value, recurseTimes);
        if (extraKeys !== undefined) {
            for (const key of extraKeys) {
                ctx.indentationLvl += 2;
                const str = formatValue(
                    ctx,
                    value[key],
                    recurseTimes,
                    typedArray
                );
                ctx.indentationLvl -= 2;
                output.push(`${ctx.stylize(`[${key}]`, "string")}: ${str}`);
            }
        }
        for (let i = 0; i < keys.length; i++) {
            output.push(
                formatProperty(ctx, value, recurseTimes, keys[i], extrasType)
            );
        }
    } catch (err) {
        if (isStackOverflow(err)) {
            ctx.seen.pop();
            ctx.indentationLvl = indentationLvl;
            const constructorName = getCtxStyle(value, constructor, tag).slice(
                0,
                -1
            );
            return ctx.stylize(
                `[${constructorName}: Inspection interrupted prematurely. Maximum call stack size exceeded.]`,
                "special"
            );
        }
        throw err;
    }
    if (ctx.circular !== undefined) {
        const index = ctx.circular.get(value);
        if (index !== undefined) {
            const reference = ctx.stylize(`<ref *${index}>`, "special");
            if (ctx.compact !== true) {
                base = base === "" ? reference : `${reference} ${base}`;
            } else {
                braces[0] = `${reference} ${braces[0]}`;
            }
        }
    }
    ctx.seen.pop();

    if (ctx.sorted) {
        const comparator = ctx.sorted === true ? undefined : ctx.sorted;
        if (extrasType === kObjectType) {
            output.sort(comparator);
        } else if (keys.length > 1) {
            const sorted = output
                .slice(output.length - keys.length)
                .sort(comparator);
            output.splice(output.length - keys.length, keys.length, ...sorted);
        }
    }

    const res = reduceToSingleString(
        ctx,
        output,
        base,
        braces,
        extrasType,
        recurseTimes,
        value
    );
    const budget = ctx.budget[ctx.indentationLvl] || 0;
    const newLength = budget + res.length;
    ctx.budget[ctx.indentationLvl] = newLength;
    // a very large output stops descending (Node's limit)
    if (newLength > 2 ** 27) ctx.depth = -1;
    return res;
}

function isStackOverflow(err: unknown) {
    return (
        err instanceof RangeError &&
        /call stack|too much recursion/i.test(err.message)
    );
}

function getEmptyFormatArray(): string[] {
    return [];
}

function formatUnknownItems(ctx: Context): string[] {
    return [ctx.stylize("<items unknown>", "special")];
}

function formatPromise(ctx: Context): string[] {
    return [ctx.stylize("<unknown>", "special")];
}

function remainingText(remaining: number) {
    return `... ${remaining} more item${remaining > 1 ? "s" : ""}`;
}

function hexBytes(bytes: Uint8Array, length: number) {
    let str = "";
    for (let i = 0; i < length; i++) {
        const byte = bytes[i];
        str += `${i === 0 ? "" : " "}${byte < 16 ? "0" : ""}${byte.toString(16)}`;
    }
    return str;
}

function formatArrayBuffer(ctx: Context, value: ArrayBuffer): string[] {
    let buffer: Uint8Array;
    try {
        buffer = new Uint8Array(value);
    } catch {
        return [ctx.stylize("(detached)", "special")];
    }
    let str = hexBytes(buffer, Math.min(ctx.maxArrayLength, buffer.length));
    const remaining = buffer.length - ctx.maxArrayLength;
    if (remaining > 0) {
        str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
    }
    return [`${ctx.stylize("[Uint8Contents]", "special")}: <${str}>`];
}

function formatArray(
    ctx: Context,
    value: unknown[],
    recurseTimes: number
): string[] {
    const valLen = value.length;
    const len = Math.min(Math.max(0, ctx.maxArrayLength), valLen);
    const remaining = valLen - len;
    const output: string[] = [];
    for (let i = 0; i < len; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        if (desc === undefined) {
            return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
        }
        output.push(
            formatProperty(ctx, value, recurseTimes, i, kArrayType, desc)
        );
    }
    if (remaining > 0) output.push(remainingText(remaining));
    return output;
}

// arrays with holes
function formatSpecialArray(
    ctx: Context,
    value: unknown[],
    recurseTimes: number,
    maxLength: number,
    output: string[],
    i: number
) {
    const keys = Object.keys(value);
    let index = i;
    for (; i < keys.length && output.length < maxLength; i++) {
        const key = keys[i];
        const tmp = +key;
        if (tmp > 2 ** 32 - 2) break;
        if (`${index}` !== key) {
            if (!numberRegExp.test(key)) break;
            const emptyItems = tmp - index;
            const ending = emptyItems > 1 ? "s" : "";
            output.push(
                ctx.stylize(`<${emptyItems} empty item${ending}>`, "undefined")
            );
            index = tmp;
            if (output.length === maxLength) break;
        }
        output.push(formatProperty(ctx, value, recurseTimes, key, kArrayType));
        index++;
    }
    const remaining = value.length - index;
    if (output.length !== maxLength) {
        if (remaining > 0) {
            const ending = remaining > 1 ? "s" : "";
            output.push(
                ctx.stylize(`<${remaining} empty item${ending}>`, "undefined")
            );
        }
    } else if (remaining > 0) {
        output.push(remainingText(remaining));
    }
    return output;
}

function formatTypedArray(
    ctx: Context,
    value: any,
    recurseTimes: number
): string[] {
    const length = value.length;
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
    const remaining = length - maxLength;
    const output: string[] = new Array(maxLength);
    const isNumbers = length > 0 && typeof value[0] === "number";
    for (let i = 0; i < maxLength; ++i) {
        output[i] = isNumbers
            ? formatNumber(ctx.stylize, value[i], ctx.numericSeparator)
            : formatBigInt(ctx.stylize, value[i], ctx.numericSeparator);
    }
    if (remaining > 0) output[maxLength] = remainingText(remaining);
    return output;
}

// the entries of a Set (values) or a Map (key => value)
function formatSetOrMap(
    ctx: Context,
    value: any,
    recurseTimes: number
): string[] {
    const isMapValue = isMap(value);
    const length = (isMapValue ? mapSize : setSize).call(value);
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
    const output: string[] = [];
    ctx.indentationLvl += 2;
    for (const entry of (isMapValue
        ? Map.prototype.entries
        : Set.prototype.values
    ).call(value)) {
        if (output.length >= maxLength) break;
        output.push(
            isMapValue
                ? `${formatValue(ctx, entry[0], recurseTimes)} => ${formatValue(ctx, entry[1], recurseTimes)}`
                : formatValue(ctx, entry, recurseTimes)
        );
    }
    if (length > maxLength) output.push(remainingText(length - maxLength));
    ctx.indentationLvl -= 2;
    return output;
}

function formatProperty(
    ctx: Context,
    value: any,
    recurseTimes: number,
    key: PropertyKey,
    type: number,
    desc?: PropertyDescriptor
) {
    let name: string;
    let str: string;
    let extra = " ";
    desc ??= Object.getOwnPropertyDescriptor(value, key) || {
        value: undefined,
        enumerable: true
    };
    if (desc.value !== undefined) {
        const diff = ctx.compact !== true || type !== kObjectType ? 2 : 3;
        ctx.indentationLvl += diff;
        str = formatValue(ctx, desc.value, recurseTimes);
        if (diff === 3 && ctx.breakLength < removeColors(str).length) {
            extra = `\n${" ".repeat(ctx.indentationLvl)}`;
        }
        ctx.indentationLvl -= diff;
    } else if (desc.get !== undefined) {
        const label = desc.set !== undefined ? "Getter/Setter" : "Getter";
        const s = ctx.stylize;
        const sp = "special";
        if (
            ctx.getters &&
            (ctx.getters === true ||
                (ctx.getters === "get" && desc.set === undefined) ||
                (ctx.getters === "set" && desc.set !== undefined))
        ) {
            ctx.indentationLvl += 2;
            try {
                const tmp = desc.get.call(value);
                if (tmp === null) {
                    str = `${s(`[${label}:`, sp)} ${s("null", "null")}${s("]", sp)}`;
                } else if (typeof tmp === "object") {
                    str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
                } else {
                    const primitive = formatPrimitive(s, tmp, ctx);
                    str = `${s(`[${label}:`, sp)} ${primitive}${s("]", sp)}`;
                }
            } catch (err) {
                const message = `<Inspection threw (${formatValue(ctx, err, recurseTimes)})>`;
                str = `${s(`[${label}:`, sp)} ${message}${s("]", sp)}`;
            }
            ctx.indentationLvl -= 2;
        } else {
            str = ctx.stylize(`[${label}]`, sp);
        }
    } else if (desc.set !== undefined) {
        str = ctx.stylize("[Setter]", "special");
    } else {
        str = ctx.stylize("undefined", "undefined");
    }
    if (type === kArrayType) return str;
    if (typeof key === "symbol") {
        name = ctx.stylize(
            key.toString().replace(strEscapeSequencesReplacer, escapeFn),
            "symbol"
        );
    } else if (keyStrRegExp.test(key as string)) {
        name =
            key === "__proto__"
                ? "['__proto__']"
                : ctx.stylize(key as string, "name");
    } else {
        name = ctx.stylize(strEscape(key as string), "string");
    }
    if (desc.enumerable === false) name = `[${name}]`;
    return `${name}:${extra}${str}`;
}

function isBelowBreakLength(
    ctx: Context,
    output: string[],
    start: number,
    base: string
) {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) return false;
    for (let i = 0; i < output.length; i++) {
        totalLength += ctx.colors
            ? removeColors(output[i]).length
            : output[i].length;
        if (totalLength > ctx.breakLength) return false;
    }
    return base === "" || !base.includes("\n");
}

function groupArrayElements(ctx: Context, output: string[], value: any) {
    let totalLength = 0;
    let maxLength = 0;
    let i = 0;
    let outputLength = output.length;
    if (ctx.maxArrayLength < output.length) {
        // the "... n more items" entry is not grouped
        outputLength--;
    }
    const separatorSpace = 2;
    const dataLen = new Array(outputLength);
    for (; i < outputLength; i++) {
        const len = ctx.colors
            ? removeColors(output[i]).length
            : output[i].length;
        dataLen[i] = len;
        totalLength += len + separatorSpace;
        if (maxLength < len) maxLength = len;
    }
    const actualMax = maxLength + separatorSpace;
    if (
        actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
        (totalLength / actualMax > 5 || maxLength <= 6)
    ) {
        const approxCharHeights = 2.5;
        const averageBias = Math.sqrt(actualMax - totalLength / output.length);
        const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
        const columns = Math.min(
            Math.round(
                Math.sqrt(approxCharHeights * biasedMax * outputLength) /
                    biasedMax
            ),
            Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
            (ctx.compact as number) * 4,
            15
        );
        if (columns <= 1) return output;
        const tmp: string[] = [];
        const maxLineLength: number[] = [];
        for (let i = 0; i < columns; i++) {
            let lineLength = 0;
            for (let j = i; j < output.length; j += columns) {
                if (dataLen[j] > lineLength) lineLength = dataLen[j];
            }
            maxLineLength.push(lineLength + separatorSpace);
        }
        let padStart = true;
        if (value !== undefined) {
            for (let i = 0; i < output.length; i++) {
                if (
                    typeof value[i] !== "number" &&
                    typeof value[i] !== "bigint"
                ) {
                    padStart = false;
                    break;
                }
            }
        }
        for (let i = 0; i < outputLength; i += columns) {
            const max = Math.min(i + columns, outputLength);
            let str = "";
            let j = i;
            for (; j < max - 1; j++) {
                const padding =
                    maxLineLength[j - i] + output[j].length - dataLen[j];
                str += padStart
                    ? `${output[j]}, `.padStart(padding, " ")
                    : `${output[j]}, `.padEnd(padding, " ");
            }
            if (padStart) {
                const padding =
                    maxLineLength[j - i] +
                    output[j].length -
                    dataLen[j] -
                    separatorSpace;
                str += output[j].padStart(padding, " ");
            } else {
                str += output[j];
            }
            tmp.push(str);
        }
        if (ctx.maxArrayLength < output.length) {
            tmp.push(output[outputLength]);
        }
        output = tmp;
    }
    return output;
}

function reduceToSingleString(
    ctx: Context,
    output: string[],
    base: string,
    braces: [string, string],
    extrasType: number,
    recurseTimes: number,
    value: unknown
) {
    if (ctx.compact !== true) {
        if (typeof ctx.compact === "number" && ctx.compact >= 1) {
            const entries = output.length;
            if (extrasType === kArrayExtrasType && entries > 6) {
                output = groupArrayElements(ctx, output, value);
            }
            if (
                ctx.currentDepth - recurseTimes < ctx.compact &&
                entries === output.length
            ) {
                const start =
                    output.length +
                    ctx.indentationLvl +
                    braces[0].length +
                    base.length +
                    10;
                if (isBelowBreakLength(ctx, output, start, base)) {
                    const joinedOutput = output.join(", ");
                    if (!joinedOutput.includes("\n")) {
                        return (
                            `${base ? `${base} ` : ""}${braces[0]} ${joinedOutput}` +
                            ` ${braces[1]}`
                        );
                    }
                }
            }
        }
        const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
        return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ${output.join(
            `,${indentation}  `
        )}${indentation}${braces[1]}`;
    }
    if (isBelowBreakLength(ctx, output, 0, base)) {
        return `${braces[0]}${base ? ` ${base}` : ""} ${output.join(", ")} ${braces[1]}`;
    }
    const indentation = " ".repeat(ctx.indentationLvl);
    const ln =
        base === "" && braces[0].length === 1
            ? " "
            : `${base ? ` ${base}` : ""}\n${indentation}  `;
    return `${braces[0]}${ln}${output.join(`,\n${indentation}  `)} ${braces[1]}`;
}

// format

const builtInObjects = new Set(
    Object.getOwnPropertyNames(globalThis).filter((name) =>
        /^[A-Z][a-zA-Z0-9]+$/.test(name)
    )
);

// whether %s shows the object with inspect: the first toString or
// Symbol.toPrimitive of its prototype chain is a built-in class's
function hasBuiltInToString(value: any) {
    const hasToString = typeof value.toString === "function";
    const hasToPrimitive = typeof value[Symbol.toPrimitive] === "function";
    if (!hasToString && !hasToPrimitive) return true;
    if (
        (hasToString && hasOwn(value, "toString")) ||
        (hasToPrimitive && hasOwn(value, Symbol.toPrimitive))
    ) {
        return false;
    }
    let pointer = value;
    do {
        pointer = Object.getPrototypeOf(pointer);
    } while (
        !(hasToString && hasOwn(pointer, "toString")) &&
        !(hasToPrimitive && hasOwn(pointer, Symbol.toPrimitive))
    );
    const descriptor = Object.getOwnPropertyDescriptor(pointer, "constructor");
    return (
        descriptor !== undefined &&
        typeof descriptor.value === "function" &&
        builtInObjects.has(descriptor.value.name)
    );
}

let circularErrorMessage: string | undefined;

function firstErrorLine(error: unknown) {
    return String((error as Error)?.message).split("\n", 1)[0];
}

function tryStringify(arg: unknown) {
    try {
        return JSON.stringify(arg);
    } catch (err) {
        if (circularErrorMessage === undefined) {
            try {
                const a: any = {};
                a.a = a;
                JSON.stringify(a);
            } catch (circularError) {
                circularErrorMessage = firstErrorLine(circularError);
            }
        }
        if (
            (err as Error)?.name === "TypeError" &&
            firstErrorLine(err) === circularErrorMessage
        ) {
            return "[Circular]";
        }
        throw err;
    }
}

// the text of one %-placeholder, undefined when it is not one
function formatArg(
    spec: number,
    arg: any,
    inspectOptions: InspectOptions | undefined
): string | undefined {
    const separator =
        inspectOptions?.numericSeparator ??
        inspectDefaultOptions.numericSeparator;
    switch (spec) {
        case 115: // s
            if (typeof arg === "number") {
                return formatNumber(stylizeNoColor, arg, separator);
            }
            if (typeof arg === "bigint") {
                return formatBigInt(stylizeNoColor, arg, separator);
            }
            if (
                typeof arg !== "object" ||
                arg === null ||
                !hasBuiltInToString(arg)
            ) {
                return String(arg);
            }
            return inspect(arg, {
                ...inspectOptions,
                depth: 0,
                colors: false,
                compact: 3
            });
        case 106: // j
            return `${tryStringify(arg)}`;
        case 100: // d
        case 105: // i
            if (typeof arg === "bigint") {
                return formatBigInt(stylizeNoColor, arg, separator);
            }
            if (typeof arg === "symbol") return "NaN";
            return formatNumber(
                stylizeNoColor,
                spec === 100 ? Number(arg) : Number.parseInt(arg),
                separator
            );
        case 102: // f
            if (typeof arg === "symbol") return "NaN";
            return formatNumber(
                stylizeNoColor,
                Number.parseFloat(arg),
                separator
            );
        case 79: // O
            return inspect(arg, inspectOptions);
        case 111: // o
            return inspect(arg, {
                ...inspectOptions,
                showHidden: true,
                showProxy: true,
                depth: 4
            });
        case 99: // c
            return "";
    }
}

function formatWithOptionsInternal(
    inspectOptions: InspectOptions | undefined,
    args: unknown[]
) {
    const first = args[0];
    let a = 0;
    let str = "";
    let join = "";
    if (typeof first === "string") {
        if (args.length === 1) return first;
        let lastPos = 0;
        for (let i = 0; i < first.length - 1; i++) {
            if (first.charCodeAt(i) !== 37) continue; // '%'
            const nextChar = first.charCodeAt(++i);
            if (nextChar === 37) {
                str += first.slice(lastPos, i);
                lastPos = i + 1;
            } else if (a + 1 !== args.length) {
                const tempStr = formatArg(
                    nextChar,
                    args[a + 1],
                    inspectOptions
                );
                if (tempStr === undefined) continue;
                a++;
                if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
                str += tempStr;
                lastPos = i + 1;
            }
        }
        if (lastPos !== 0) {
            a++;
            join = " ";
            if (lastPos < first.length) str += first.slice(lastPos);
        }
    }
    while (a < args.length) {
        const value = args[a];
        str += join;
        str +=
            typeof value !== "string" ? inspect(value, inspectOptions) : value;
        join = " ";
        a++;
    }
    return str;
}

function format(...args: unknown[]): string {
    return formatWithOptionsInternal(undefined, args);
}

function formatWithOptions(
    inspectOptions: InspectOptions,
    ...args: unknown[]
): string {
    if (inspectOptions === null || typeof inspectOptions !== "object") {
        throw invalidArgType(
            "inspectOptions",
            "of type object",
            inspectOptions
        );
    }
    return formatWithOptionsInternal(inspectOptions, args);
}

export { inspect, format, formatWithOptions, stylizeNoColor };
