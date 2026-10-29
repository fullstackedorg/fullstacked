// The deep-equality algorithm of Node (lib/internal/util/comparisons.js),
// shared by util.isDeepStrictEqual and assert's deep and partial modes.
//
// - strict: Object.is for primitives, same constructor (or prototype), same
//   toString tag, own enumerable symbol keys compared;
// - loose: == for primitives (NaN equals NaN), prototypes ignored;
// - partial (assert.partialDeepStrictEqual): strict, but only what
//   `expected` (the second value) has must be in `actual`.
// Map and Set entries are matched regardless of order, object keys of Sets
// and Maps by deep equality. Like Node, comparisons run without cycle
// detection until one overflows the stack (a cycle): from then on they keep
// track of the pairs being compared.
// Not comparable in a page: the key material of CryptoKeys (compared by
// identity), like the contents of WeakMap, WeakSet and Promise in Node.

import {
    isAnyArrayBuffer,
    isArrayBufferView,
    isBigIntObject,
    isBooleanObject,
    isBoxedPrimitive,
    isCryptoKey,
    isDate,
    isFloat16Array,
    isFloat32Array,
    isFloat64Array,
    isKeyObject,
    isMap,
    isNativeError,
    isNumberObject,
    isPromise,
    isRegExp,
    isSet,
    isStringObject,
    isSymbolObject,
    isWeakMap,
    isWeakSet
} from "./types.ts";
import {
    hasOwn,
    isEnumerable,
    isIndex,
    isURL,
    objectToString,
    typedArrayKind
} from "./internal.ts";

const kStrict = 2;
const kStrictWithoutPrototypes = 3;
const kLoose = 0;
const kPartial = 1;
type Mode = 0 | 1 | 2 | 3;

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

// null: no cycle detection; undefined: the first object pair starts it
type Memos = {
    set: Set<unknown> | undefined;
    a: unknown;
    b: unknown;
    c: unknown;
    d: unknown;
    deep: boolean;
} | null;

const wellKnownConstructors = new Set<unknown>([
    Array,
    ArrayBuffer,
    BigInt,
    BigInt64Array,
    BigUint64Array,
    Boolean,
    DataView,
    Date,
    Error,
    Float32Array,
    Float64Array,
    (globalThis as any).Float16Array,
    Function,
    Int16Array,
    Int32Array,
    Int8Array,
    Map,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    Symbol,
    Uint16Array,
    Uint32Array,
    Uint8Array,
    Uint8ClampedArray,
    WeakMap,
    WeakSet
]);

const isWellKnownConstructor = (ctor: unknown) =>
    wellKnownConstructors.has(ctor) ||
    (ctor !== undefined && ctor === (globalThis as any).Buffer);

const isError = (value: unknown) =>
    isNativeError(value) || value instanceof Error;

// own enumerable keys that are not indices (symbols too, except loose)
function nonIndexKeys(value: object, mode: Mode): PropertyKey[] {
    const keys: PropertyKey[] = [];
    const names = Object.keys(value);
    // indices come first: a dense array without extras is all indices
    const length = (value as ArrayLike<unknown>).length;
    if (
        names.length !== length ||
        (length > 0 && !isIndex(names[length - 1]))
    ) {
        for (const key of names) if (!isIndex(key)) keys.push(key);
    }
    if (mode !== kLoose) {
        for (const symbol of Object.getOwnPropertySymbols(value)) {
            if (isEnumerable(value, symbol)) keys.push(symbol);
        }
    }
    return keys;
}

const bytesOf = (view: ArrayBufferView) =>
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

function equalBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function areSimilarRegExps(a: RegExp, b: RegExp) {
    return (
        a.source === b.source &&
        a.flags === b.flags &&
        a.lastIndex === b.lastIndex
    );
}

// the bytes of b appear in a, in order
function isPartialUint8Array(a: Uint8Array, b: Uint8Array) {
    const lenA = a.length;
    const lenB = b.length;
    if (lenA < lenB) return false;
    let offsetA = 0;
    for (let offsetB = 0; offsetB < lenB; offsetB++) {
        while (a[offsetA] !== b[offsetB]) {
            offsetA++;
            if (offsetA > lenA - lenB + offsetB) return false;
        }
        offsetA++;
    }
    return true;
}

const boxes: [(value: unknown) => boolean, { prototype: object }][] = [
    [isNumberObject, Number],
    [isStringObject, String],
    [isBooleanObject, Boolean],
    [isBigIntObject, BigInt],
    [isSymbolObject, Symbol]
];

function isEqualBoxedPrimitive(a: object, b: object) {
    for (const [is, { prototype }] of boxes) {
        if (is(a)) {
            const valueOf = (prototype as Number).valueOf;
            return is(b) && Object.is(valueOf.call(a), valueOf.call(b));
        }
    }
    return false;
}

function isEnumerableOrIdentical(
    val1: any,
    val2: any,
    prop: string,
    mode: Mode,
    memos: Memos | undefined
) {
    return (
        isEnumerable(val2, prop) ||
        (mode === kPartial &&
            (val2[prop] === undefined ||
                (prop === "message" && val2[prop] === ""))) ||
        innerDeepEqual(val1[prop], val2[prop], mode, memos)
    );
}

function innerDeepEqual(
    val1: any,
    val2: any,
    mode: Mode,
    memos: Memos | undefined
): boolean {
    if (val1 === val2) {
        return val1 !== 0 || Object.is(val1, val2) || mode === kLoose;
    }
    if (mode !== kLoose) {
        if (typeof val1 === "number") {
            // eslint-disable-next-line no-self-compare
            return val1 !== val1 && val2 !== val2;
        }
        if (
            typeof val2 !== "object" ||
            typeof val1 !== "object" ||
            val1 === null ||
            val2 === null
        ) {
            return false;
        }
    } else {
        if (val1 === null || typeof val1 !== "object") {
            return (
                (val2 === null || typeof val2 !== "object") &&
                // eslint-disable-next-line eqeqeq, no-self-compare
                (val1 == val2 || (val1 !== val1 && val2 !== val2))
            );
        }
        if (val2 === null || typeof val2 !== "object") return false;
    }
    return objectComparisonStart(val1, val2, mode, memos);
}

function hasUnequalTag(val1: any, val2: any) {
    return val1[Symbol.toStringTag] !== val2[Symbol.toStringTag];
}

function slowHasUnequalTag(val1Tag: string, val1: any, val2: any) {
    if (
        val1[Symbol.toStringTag] !== undefined &&
        val2[Symbol.toStringTag] !== undefined
    ) {
        return val1[Symbol.toStringTag] !== val2[Symbol.toStringTag];
    }
    return val1Tag !== objectToString.call(val2);
}

function objectComparisonStart(
    val1: any,
    val2: any,
    mode: Mode,
    memos: Memos | undefined
): boolean {
    if (mode === kStrict) {
        if (
            isWellKnownConstructor(val1.constructor) ||
            (val1.constructor !== undefined && !hasOwn(val1, "constructor"))
        ) {
            if (val1.constructor !== val2.constructor) return false;
        } else if (
            Object.getPrototypeOf(val1) !== Object.getPrototypeOf(val2)
        ) {
            return false;
        }
    }

    if (Array.isArray(val1)) {
        if (
            !Array.isArray(val2) ||
            (val1.length !== val2.length &&
                (mode !== kPartial || val1.length < val2.length)) ||
            hasUnequalTag(val1, val2)
        ) {
            return false;
        }
        const keys2 = nonIndexKeys(val2, mode);
        if (
            mode !== kPartial &&
            keys2.length !== nonIndexKeys(val1, mode).length
        ) {
            return false;
        }
        return keyCheck(val1, val2, mode, memos, kIsArray, keys2);
    }

    let val1Tag: string | undefined;
    if (
        val1[Symbol.toStringTag] === undefined &&
        (val1Tag = objectToString.call(val1)) === "[object Object]"
    ) {
        if (slowHasUnequalTag(val1Tag, val1, val2)) return false;
        return keyCheck(val1, val2, mode, memos, kNoIterator);
    } else if (isSet(val1) || isMap(val1)) {
        const set = isSet(val1);
        if (
            !(set ? isSet(val2) : isMap(val2)) ||
            (val1.size !== val2.size &&
                (mode !== kPartial || val1.size < val2.size)) ||
            hasUnequalTag(val1, val2)
        ) {
            return false;
        }
        return keyCheck(val1, val2, mode, memos, set ? kIsSet : kIsMap);
    } else if (isArrayBufferView(val1)) {
        if (
            !isArrayBufferView(val2) ||
            typedArrayKind.call(val1) !== typedArrayKind.call(val2)
        ) {
            return false;
        }
        if (mode === kPartial && val1.byteLength !== val2.byteLength) {
            if (
                val1.byteLength < val2.byteLength ||
                !isPartialUint8Array(bytesOf(val1), bytesOf(val2))
            ) {
                return false;
            }
        } else if (
            mode === kLoose &&
            (isFloat32Array(val1) ||
                isFloat64Array(val1) ||
                isFloat16Array(val1))
        ) {
            if (val1.byteLength !== val2.byteLength) return false;
            for (let i = 0; i < val1.length; i++) {
                if (val1[i] !== val2[i]) return false;
            }
        } else if (!equalBytes(bytesOf(val1), bytesOf(val2))) {
            return false;
        }
        const keys2 = nonIndexKeys(val2, mode);
        if (
            mode !== kPartial &&
            keys2.length !== nonIndexKeys(val1, mode).length
        ) {
            return false;
        }
        return keyCheck(val1, val2, mode, memos, kNoIterator, keys2);
    } else if (isDate(val1)) {
        if (!isDate(val2) || hasUnequalTag(val1, val2)) return false;
        const time1 = Date.prototype.getTime.call(val1);
        const time2 = Date.prototype.getTime.call(val2);
        // eslint-disable-next-line no-self-compare
        if (time1 !== time2 && (time1 === time1 || time2 === time2)) {
            return false;
        }
    } else if (isRegExp(val1)) {
        if (
            !isRegExp(val2) ||
            !areSimilarRegExps(val1, val2) ||
            hasUnequalTag(val1, val2)
        ) {
            return false;
        }
    } else if (isAnyArrayBuffer(val1)) {
        if (!isAnyArrayBuffer(val2) || hasUnequalTag(val1, val2)) {
            return false;
        }
        const a = new Uint8Array(val1);
        const b = new Uint8Array(val2);
        if (mode !== kPartial || a.length === b.length) {
            if (!equalBytes(a, b)) return false;
        } else if (!isPartialUint8Array(a, b)) {
            return false;
        }
    } else if (
        slowHasUnequalTag(val1Tag ?? objectToString.call(val1), val1, val2) ||
        Array.isArray(val2) ||
        isArrayBufferView(val2) ||
        isSet(val2) ||
        isMap(val2) ||
        isDate(val2) ||
        isRegExp(val2) ||
        isAnyArrayBuffer(val2)
    ) {
        return false;
    } else if (isError(val1)) {
        // the stack is not compared: it differs between equal errors
        if (
            !isError(val2) ||
            !isEnumerableOrIdentical(val1, val2, "message", mode, memos) ||
            !isEnumerableOrIdentical(val1, val2, "name", mode, memos) ||
            !isEnumerableOrIdentical(val1, val2, "cause", mode, memos) ||
            !isEnumerableOrIdentical(val1, val2, "errors", mode, memos)
        ) {
            return false;
        }
        const hasOwnVal2Cause = hasOwn(val2, "cause");
        if (
            hasOwnVal2Cause !== hasOwn(val1, "cause") &&
            (mode !== kPartial || hasOwnVal2Cause)
        ) {
            return false;
        }
    } else if (isBoxedPrimitive(val1)) {
        if (!isEqualBoxedPrimitive(val1, val2)) return false;
    } else if (isURL(val1)) {
        if (!isURL(val2) || val1.href !== val2.href) return false;
    } else if (isKeyObject(val1)) {
        if (
            !isKeyObject(val2) ||
            (typeof val1.equals === "function" && !val1.equals(val2))
        ) {
            return false;
        }
    } else if (isCryptoKey(val1)) {
        return false;
    } else if (
        isBoxedPrimitive(val2) ||
        isError(val2) ||
        isWeakMap(val1) ||
        isWeakSet(val1) ||
        isPromise(val1)
    ) {
        return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator);
}

function keyCheck(
    val1: any,
    val2: any,
    mode: Mode,
    memos: Memos | undefined,
    iterationType: number,
    keys2?: PropertyKey[]
): boolean {
    const isArrayLikeObject = keys2 !== undefined;
    if (keys2 === undefined) keys2 = Object.keys(val2);
    let keys1: PropertyKey[] | undefined;

    if (!isArrayLikeObject) {
        if (mode === kPartial) {
            for (const key of Object.getOwnPropertySymbols(val2)) {
                if (isEnumerable(val2, key)) keys2.push(key);
            }
        } else if (keys2.length !== (keys1 = Object.keys(val1)).length) {
            return false;
        } else if (mode === kStrict || mode === kStrictWithoutPrototypes) {
            for (const key of Object.getOwnPropertySymbols(val1)) {
                if (isEnumerable(val1, key)) keys1.push(key);
            }
            for (const key of Object.getOwnPropertySymbols(val2)) {
                if (isEnumerable(val2, key)) keys2.push(key);
            }
            if (keys1.length !== keys2.length) return false;
        }
    }

    if (
        keys2.length === 0 &&
        (iterationType === kNoIterator ||
            (iterationType === kIsArray && val2.length === 0) ||
            val2.size === 0)
    ) {
        return true;
    }

    if (memos === null) {
        return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
    }
    return handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType);
}

function handleCycles(
    val1: any,
    val2: any,
    mode: Mode,
    keys1: PropertyKey[] | undefined,
    keys2: PropertyKey[],
    memos: Memos | undefined,
    iterationType: number
): boolean {
    if (memos === undefined) {
        memos = {
            set: undefined,
            a: val1,
            b: val2,
            c: undefined,
            d: undefined,
            deep: false
        };
        return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
    }

    if (memos.set === undefined) {
        if (memos.deep === false) {
            if (memos.a === val1) return memos.b === val2;
            if (memos.b === val2) return false;
            memos.c = val1;
            memos.d = val2;
            memos.deep = true;
            const result = objEquiv(
                val1,
                val2,
                mode,
                keys1,
                keys2,
                memos,
                iterationType
            );
            memos.deep = false;
            if (memos.set !== undefined) {
                memos.set.delete(memos.c);
                memos.set.delete(memos.d);
            }
            return result;
        }
        memos.set = new Set([memos.a, memos.b, memos.c, memos.d]);
    }

    const { set } = memos;
    const originalSize = set.size;
    set.add(val1);
    set.add(val2);
    if (originalSize !== set.size - 2) return originalSize === set.size;

    const areEq = objEquiv(
        val1,
        val2,
        mode,
        keys1,
        keys2,
        memos,
        iterationType
    );
    set.delete(val1);
    set.delete(val2);
    return areEq;
}

// the primitive a loose comparison could match `prim` with: null when it
// has to be looked for, false/true when the answer is known
function findLooseMatchingPrimitives(prim: any) {
    switch (typeof prim) {
        case "undefined":
            return null;
        case "object":
            return undefined;
        case "symbol":
            return false;
        case "string":
            prim = +prim;
        // fall through
        case "number":
            // eslint-disable-next-line no-self-compare
            if (prim !== prim) return false;
    }
    return true;
}

function setMightHaveLoosePrim(
    a: Set<unknown>,
    b: Set<unknown>,
    prim: unknown
) {
    const altValue = findLooseMatchingPrimitives(prim);
    if (altValue != null) return altValue;
    return !b.has(altValue) && a.has(altValue);
}

function mapMightHaveLoosePrim(
    a: Map<unknown, unknown>,
    b: Map<unknown, unknown>,
    prim: unknown,
    item2: unknown,
    memo: Memos | undefined
) {
    const altValue = findLooseMatchingPrimitives(prim);
    if (altValue != null) return altValue;
    const item1 = a.get(altValue);
    if (
        (item1 === undefined && !a.has(altValue)) ||
        !innerDeepEqual(item1, item2, kLoose, memo)
    ) {
        return false;
    }
    return !b.has(altValue) && innerDeepEqual(item1, item2, kLoose, memo);
}

// The entries of b without an identical one in a are matched one by one
// with the remaining entries of a (Node orders these comparisons to be
// linear on sets in the same or the reverse order; the outcome is the same).

// removes from `pool` the first entry equal to `val`
function takeEqual(
    pool: unknown[],
    val: unknown,
    equal: (candidate: unknown) => boolean
) {
    for (let i = 0; i < pool.length; i++) {
        if (equal(pool[i])) {
            pool.splice(i, 1);
            return true;
        }
    }
    return false;
}

function setEquiv(
    a: Set<unknown>,
    b: Set<unknown>,
    mode: Mode,
    memo: Memos | undefined
) {
    let unmatched: unknown[] | undefined;
    for (const val of b) {
        if (!a.has(val)) {
            if (
                (typeof val !== "object" || val === null) &&
                (mode !== kLoose || !setMightHaveLoosePrim(a, b, val))
            ) {
                return false;
            }
            (unmatched ??= []).push(val);
        }
    }
    if (unmatched === undefined) return true;
    // the entries of a that b does not have, in loose mode primitives too
    const pool: unknown[] = [];
    for (const val of a) {
        if (
            !b.has(val) &&
            (mode === kLoose || (typeof val === "object" && val !== null))
        ) {
            pool.push(val);
        }
    }
    if (mode !== kPartial && pool.length !== unmatched.length) return false;
    for (const val of unmatched) {
        if (
            !takeEqual(pool, val, (candidate) =>
                innerDeepEqual(candidate, val, mode, memo)
            )
        ) {
            return false;
        }
    }
    return true;
}

function mapEquiv(
    a: Map<unknown, unknown>,
    b: Map<unknown, unknown>,
    mode: Mode,
    memo: Memos | undefined
) {
    let unmatched: unknown[] | undefined;
    for (const [key2, item2] of b) {
        if (typeof key2 === "object" && key2 !== null) {
            (unmatched ??= []).push(key2);
        } else {
            const item1 = a.get(key2);
            if (
                (item1 === undefined && !a.has(key2)) ||
                !innerDeepEqual(item1, item2, mode, memo)
            ) {
                if (mode !== kLoose) return false;
                if (!mapMightHaveLoosePrim(a, b, key2, item2, memo)) {
                    return false;
                }
                (unmatched ??= []).push(key2);
            }
        }
    }
    if (unmatched === undefined) return true;
    const pool: unknown[] = [];
    for (const [key1, item1] of a) {
        if (typeof key1 === "object" && key1 !== null) {
            pool.push(key1);
        } else if (
            mode === kLoose &&
            !(b.has(key1) && innerDeepEqual(item1, b.get(key1), mode, memo))
        ) {
            pool.push(key1);
        }
    }
    if (mode !== kPartial && pool.length !== unmatched.length) return false;
    for (const key2 of unmatched) {
        const item2 = b.get(key2);
        if (
            !takeEqual(
                pool,
                key2,
                (key1) =>
                    innerDeepEqual(key1, key2, mode, memo) &&
                    innerDeepEqual(a.get(key1), item2, mode, memo)
            )
        ) {
            return false;
        }
    }
    return true;
}

function partialSparseArrayEquiv(
    a: any,
    b: any,
    mode: Mode,
    memos: Memos | undefined,
    startA: number,
    startB: number
) {
    let aPos = startA;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    const lenA = keysA.length - startA;
    const lenB = keysB.length - startB;
    if (lenA < lenB) return false;
    for (let i = 0; i < lenB; i++) {
        const keyB = keysB[startB + i];
        while (!innerDeepEqual(a[keysA[aPos]], b[keyB], mode, memos)) {
            aPos++;
            if (aPos > keysA.length - lenB + i) return false;
        }
        aPos++;
    }
    return true;
}

function partialArrayEquiv(
    a: any,
    b: any,
    mode: Mode,
    memos: Memos | undefined
) {
    let aPos = 0;
    for (let i = 0; i < b.length; i++) {
        let isSparse = b[i] === undefined && !hasOwn(b, i);
        if (isSparse) {
            return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
        }
        while (
            !(isSparse = a[aPos] === undefined && !hasOwn(a, aPos)) &&
            !innerDeepEqual(a[aPos], b[i], mode, memos)
        ) {
            aPos++;
            if (aPos > a.length - b.length + i) return false;
        }
        if (isSparse) {
            return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
        }
        aPos++;
    }
    return true;
}

function sparseArrayEquiv(
    a: any,
    b: any,
    mode: Mode,
    memos: Memos | undefined,
    i: number
) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (; i < keysB.length; i++) {
        const key = keysB[i];
        if (
            (a[key] === undefined && !hasOwn(a, key)) ||
            !innerDeepEqual(a[key], b[key], mode, memos)
        ) {
            return false;
        }
    }
    return true;
}

function objEquiv(
    a: any,
    b: any,
    mode: Mode,
    keys1: PropertyKey[] | undefined,
    keys2: PropertyKey[],
    memos: Memos | undefined,
    iterationType: number
): boolean {
    if (keys2.length > 0) {
        let i = 0;
        // keys in the same order need no lookup
        if (keys1 !== undefined) {
            for (; i < keys2.length; i++) {
                const key = keys2[i];
                if (keys1[i] !== key) break;
                if (!innerDeepEqual(a[key], b[key], mode, memos)) return false;
            }
        }
        for (; i < keys2.length; i++) {
            const key = keys2[i];
            const descriptor = Object.getOwnPropertyDescriptor(a, key);
            if (descriptor === undefined || descriptor.enumerable !== true) {
                return false;
            }
            const value =
                descriptor.writable !== undefined ? descriptor.value : a[key];
            if (!innerDeepEqual(value, b[key], mode, memos)) return false;
        }
    }

    if (iterationType === kIsArray) {
        if (mode === kPartial) return partialArrayEquiv(a, b, mode, memos);
        for (let i = 0; i < a.length; i++) {
            if (b[i] === undefined) {
                if (!hasOwn(b, i)) {
                    return sparseArrayEquiv(a, b, mode, memos, i);
                }
                if (
                    (a[i] !== undefined || !hasOwn(a, i)) &&
                    (mode !== kLoose || a[i] !== null)
                ) {
                    return false;
                }
            } else if (
                (a[i] === undefined ||
                    !innerDeepEqual(a[i], b[i], mode, memos)) &&
                (mode !== kLoose || b[i] !== null)
            ) {
                return false;
            }
        }
    } else if (iterationType === kIsSet) {
        return setEquiv(a, b, mode, memos);
    } else if (iterationType === kIsMap) {
        return mapEquiv(a, b, mode, memos);
    }
    return true;
}

// without cycle detection until a comparison overflows the stack
let detectCycles = (val1: unknown, val2: unknown, mode: Mode): boolean => {
    try {
        return innerDeepEqual(val1, val2, mode, null);
    } catch {
        detectCycles = (val1, val2, mode) =>
            innerDeepEqual(val1, val2, mode, undefined);
        return detectCycles(val1, val2, mode);
    }
};

export function isDeepEqual(val1: unknown, val2: unknown) {
    return detectCycles(val1, val2, kLoose);
}

export function isDeepStrictEqual(
    val1: unknown,
    val2: unknown,
    skipPrototype?: boolean
) {
    return detectCycles(
        val1,
        val2,
        skipPrototype ? kStrictWithoutPrototypes : kStrict
    );
}

export function isPartialStrictEqual(actual: unknown, expected: unknown) {
    return detectCycles(actual, expected, kPartial);
}
