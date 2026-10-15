// node:util/types (Node 24), improvements/shim/plan.md 5.4.
//
// Node asks V8 for the internal type of a value; a page cannot, so each
// check reads Object.prototype.toString and confirms the brand with a
// built-in method that only works on the real thing (a getter or valueOf that
// throws on anything else). The confirmation only runs when the tag matches
// or when the value carries a Symbol.toStringTag that could hide the brand,
// so the common negative answer costs one toString.
// An object moved to another prototype that has no tag (a Map made a plain
// object with Object.setPrototypeOf) is not recognized.
//
// Not detectable from JavaScript: isProxy (always false) and isExternal
// (always false, there are no V8 externals in a page).

import type * as NodeTypes from "node:util/types";

const objectToString = Object.prototype.toString;
const getter = (proto: object, key: PropertyKey) =>
    Object.getOwnPropertyDescriptor(proto, key)?.get as (
        this: unknown
    ) => unknown;

// the typed array kind ("Uint8Array", ...) or undefined, never throws
const typedArrayKind = getter(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag
) as (this: unknown) => string | undefined;

function works(fn: Function, value: unknown, arg?: unknown) {
    try {
        fn.call(value, arg);
        return true;
    } catch {
        return false;
    }
}

// a check for the brand whose toString tag is `tag`, confirmed by `confirm`
function brand(tag: string, confirm: Function, arg?: unknown) {
    const full = `[object ${tag}]`;
    return (value: unknown): boolean => {
        if (typeof value !== "object" || value === null) return false;
        // a tag that differs is only checked further when it may hide the
        // brand: a Symbol.toStringTag, or no prototype to read one from
        if (
            objectToString.call(value) !== full &&
            !(Symbol.toStringTag in value) &&
            Object.getPrototypeOf(value) !== null
        ) {
            return false;
        }
        return works(confirm, value, arg);
    };
}

const SharedArrayBufferCtor = (globalThis as any).SharedArrayBuffer as
    typeof SharedArrayBuffer | undefined;
const MapIteratorPrototype = Object.getPrototypeOf(new Map().entries());
const SetIteratorPrototype = Object.getPrototypeOf(new Set().values());
const GeneratorPrototype = Object.getPrototypeOf(
    Object.getPrototypeOf((function* () {})())
);
const AsyncGeneratorPrototype = Object.getPrototypeOf(
    Object.getPrototypeOf((async function* () {})())
);
const ErrorIsError = (Error as any).isError as
    ((value: unknown) => boolean) | undefined;

export const isDate = brand("Date", Date.prototype.getTime);
export const isRegExp = brand("RegExp", getter(RegExp.prototype, "source"));
export const isMap = brand("Map", getter(Map.prototype, "size"));
export const isSet = brand("Set", getter(Set.prototype, "size"));
export const isWeakMap = brand("WeakMap", WeakMap.prototype.has);
export const isWeakSet = brand("WeakSet", WeakSet.prototype.has);
export const isArrayBuffer = brand(
    "ArrayBuffer",
    getter(ArrayBuffer.prototype, "byteLength")
);
export const isSharedArrayBuffer: (value: unknown) => boolean =
    SharedArrayBufferCtor
        ? brand(
              "SharedArrayBuffer",
              getter(SharedArrayBufferCtor.prototype, "byteLength")
          )
        : () => false;
export const isNumberObject = brand("Number", Number.prototype.valueOf);
export const isStringObject = brand("String", String.prototype.valueOf);
export const isBooleanObject = brand("Boolean", Boolean.prototype.valueOf);
export const isBigIntObject = brand("BigInt", BigInt.prototype.valueOf);
export const isSymbolObject = brand("Symbol", Symbol.prototype.valueOf);

export function isAnyArrayBuffer(value: unknown): boolean {
    return isArrayBuffer(value) || isSharedArrayBuffer(value);
}

export function isBoxedPrimitive(value: unknown): boolean {
    return (
        isNumberObject(value) ||
        isStringObject(value) ||
        isBooleanObject(value) ||
        isBigIntObject(value) ||
        isSymbolObject(value)
    );
}

export function isPromise(value: unknown): boolean {
    return (
        value instanceof Promise ||
        (typeof value === "object" &&
            value !== null &&
            objectToString.call(value) === "[object Promise]" &&
            typeof (value as Promise<unknown>).then === "function")
    );
}

export function isNativeError(value: unknown): boolean {
    if (ErrorIsError) return ErrorIsError(value);
    if (typeof value !== "object" || value === null) return false;
    return Symbol.toStringTag in value
        ? value instanceof Error
        : objectToString.call(value) === "[object Error]";
}

export function isArgumentsObject(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        !(Symbol.toStringTag in value) &&
        objectToString.call(value) === "[object Arguments]"
    );
}

function functionTag(value: unknown) {
    return typeof value === "function" ? objectToString.call(value) : "";
}

export function isAsyncFunction(value: unknown): boolean {
    const tag = functionTag(value);
    return (
        tag === "[object AsyncFunction]" ||
        tag === "[object AsyncGeneratorFunction]"
    );
}

export function isGeneratorFunction(value: unknown): boolean {
    const tag = functionTag(value);
    return (
        tag === "[object GeneratorFunction]" ||
        tag === "[object AsyncGeneratorFunction]"
    );
}

export function isGeneratorObject(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (GeneratorPrototype.isPrototypeOf(value) ||
            AsyncGeneratorPrototype.isPrototypeOf(value))
    );
}

export function isMapIterator(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        MapIteratorPrototype.isPrototypeOf(value)
    );
}

export function isSetIterator(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        SetIteratorPrototype.isPrototypeOf(value)
    );
}

export function isModuleNamespaceObject(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === null &&
        !Object.isExtensible(value) &&
        objectToString.call(value) === "[object Module]"
    );
}

export function isArrayBufferView(value: unknown): boolean {
    return ArrayBuffer.isView(value);
}

export function isDataView(value: unknown): boolean {
    return (
        ArrayBuffer.isView(value) && typedArrayKind.call(value) === undefined
    );
}

export function isTypedArray(value: unknown): boolean {
    return typedArrayKind.call(value) !== undefined;
}

const kind =
    (name: string) =>
    (value: unknown): boolean =>
        typedArrayKind.call(value) === name;

export const isUint8Array = kind("Uint8Array");
export const isUint8ClampedArray = kind("Uint8ClampedArray");
export const isUint16Array = kind("Uint16Array");
export const isUint32Array = kind("Uint32Array");
export const isInt8Array = kind("Int8Array");
export const isInt16Array = kind("Int16Array");
export const isInt32Array = kind("Int32Array");
export const isFloat16Array = kind("Float16Array");
export const isFloat32Array = kind("Float32Array");
export const isFloat64Array = kind("Float64Array");
export const isBigInt64Array = kind("BigInt64Array");
export const isBigUint64Array = kind("BigUint64Array");

// a Proxy cannot be told apart from its target in JavaScript
export function isProxy(_value: unknown): boolean {
    return false;
}

export function isExternal(_value: unknown): boolean {
    return false;
}

// lib/crypto's KeyObject (not imported here): an object with a key type and
// an export method
export function isKeyObject(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const key = value as { type?: unknown; export?: unknown };
    return (
        (key.type === "secret" ||
            key.type === "public" ||
            key.type === "private") &&
        typeof key.export === "function"
    );
}

export function isCryptoKey(value: unknown): boolean {
    const CryptoKeyCtor = (globalThis as any).CryptoKey;
    return (
        typeof CryptoKeyCtor === "function" && value instanceof CryptoKeyCtor
    );
}

const types = {
    isArgumentsObject,
    isArrayBuffer,
    isAsyncFunction,
    isBigIntObject,
    isBooleanObject,
    isDate,
    isExternal,
    isGeneratorFunction,
    isGeneratorObject,
    isMap,
    isMapIterator,
    isModuleNamespaceObject,
    isNativeError,
    isNumberObject,
    isPromise,
    isProxy,
    isRegExp,
    isSet,
    isSetIterator,
    isSharedArrayBuffer,
    isStringObject,
    isSymbolObject,
    isWeakMap,
    isWeakSet,
    isAnyArrayBuffer,
    isBoxedPrimitive,
    isArrayBufferView,
    isDataView,
    isTypedArray,
    isUint8Array,
    isUint8ClampedArray,
    isUint16Array,
    isUint32Array,
    isInt8Array,
    isInt16Array,
    isInt32Array,
    isFloat16Array,
    isFloat32Array,
    isFloat64Array,
    isBigInt64Array,
    isBigUint64Array,
    isKeyObject,
    isCryptoKey
} as unknown as typeof NodeTypes;

export { types as default, types as "module.exports" };
