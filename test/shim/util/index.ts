import test, { suite } from "node:test";
import assert from "node:assert";
import nodeUtil from "node:util";
import * as libUtil from "../../../core/internal/bundle/lib/util/index.ts";
import * as libUtilTypes from "../../../core/internal/bundle/lib/util/types.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import { sameFor, settle } from "../common.ts";

type UtilModule = typeof nodeUtil;
type Env = { util: UtilModule; Buffer: typeof Buffer };
const shim: Env = {
    util: ((libUtil as any).default ?? libUtil) as UtilModule,
    Buffer: (libBuffer as any).Buffer
};
const node: Env = { util: nodeUtil, Buffer };
const same = sameFor<Env>("util", shim, node);

class Point {
    x = 1;
    y = 2;
}
const circular: any = { name: "loop" };
circular.self = circular;

// values for inspect and the type checks, built per implementation where
// they hold a Buffer
function values(B: typeof Buffer): [string, unknown][] {
    return [
        ["string", 'it\'s "quoted"\n'],
        ["number", -0],
        ["bigint", 12n],
        ["symbol", Symbol("s")],
        ["undefined", undefined],
        ["null", null],
        ["array", [1, "a", [2, [3, [4, [5]]]]]],
        ["sparse array", [1, , 3]],
        ["long array", Array.from({ length: 120 }, (_, i) => i)],
        ["nested object", { a: { b: { c: { d: { e: 1 } } } } }],
        ["object with symbol key", { [Symbol("k")]: 1, plain: 2 }],
        ["class instance", new Point()],
        ["null prototype", Object.assign(Object.create(null), { a: 1 })],
        ["circular", circular],
        [
            "map",
            new Map<unknown, unknown>([
                ["a", 1],
                [{ k: 1 }, [2]]
            ])
        ],
        ["set", new Set([1, "two", { three: 3 }])],
        ["date", new Date(0)],
        ["invalid date", new Date(NaN)],
        ["regexp", /a+b/gi],
        ["function", function named() {}],
        ["arrow", () => {}],
        ["class", Point],
        ["error", new RangeError("bad")],
        ["typed array", new Float32Array([1.5, 2])],
        ["buffer", B.from("hello")],
        ["arraybuffer", new Uint8Array([1, 2, 3]).buffer],
        ["dataview", new DataView(new ArrayBuffer(2))],
        ["promise", Promise.resolve(1)],
        ["boxed", [new Number(1), new String("s"), new Boolean(false)]],
        ["weakmap", new WeakMap()],
        [
            "getter",
            Object.defineProperty({}, "g", { get: () => 1, enumerable: true })
        ],
        ["long string", "x".repeat(200)],
        ["multiline keys", { "a-b": 1, "1x": 2, valid_id: 3 }]
    ];
}

const errorStack = (s: string) => s.split("\n")[0];

suite("shim util - inspect", () => {
    for (const [name] of values(Buffer)) {
        // a choice, tested on its own below
        if (name === "promise") continue;
        same(`inspect ${name}`, ({ util, Buffer }) => {
            const value = values(Buffer).find(([n]) => n === name)[1];
            const out = util.inspect(value);
            // stacks differ by file and line
            return name === "error" ? errorStack(out) : out;
        });
    }
    // A page cannot read a promise's state (Node asks V8): every promise
    // prints as pending would, with <unknown> as its state
    test("inspect promise: the state is not observable in a page", () => {
        // node:test adds its async_id symbols to every promise, printed after
        assert.match(
            shim.util.inspect(Promise.resolve(1)),
            /^Promise \{\s*<unknown>/
        );
    });
    same("inspect options: depth, breakLength, compact, sorted", ({ util }) => {
        const value = { b: { c: { d: { e: {} } } }, a: [1, 2, 3] };
        return [
            util.inspect(value, { depth: 0 }),
            util.inspect(value, { depth: Infinity }),
            util.inspect(value, { breakLength: 10 }),
            util.inspect(value, { compact: false }),
            util.inspect(value, { sorted: true }),
            util.inspect("s", { colors: true })
        ];
    });
    same("inspect.custom", ({ util }) => {
        const value = {
            [util.inspect.custom]: (depth: number, options: object) =>
                `custom ${depth} ${typeof options}`
        };
        return [
            util.inspect(value),
            util.inspect.custom === Symbol.for("nodejs.util.inspect.custom")
        ];
    });
    same("inspect.defaultOptions", ({ util }) => util.inspect.defaultOptions);
});

suite("shim util - format", () => {
    same("format specifiers", ({ util }) => [
        util.format("%s %s %s", "a", 1, { x: 1 }),
        util.format("%s", Symbol("s")),
        util.format("%s", 10n),
        util.format("%s", [1, [2]]),
        util.format("%d %d %d %d", 42, "42", 1.5, 10n),
        util.format("%i %i", 42.9, "x"),
        util.format("%f %f", "1.5", "x"),
        util.format("%j", { a: [1] }),
        util.format("%j", circular),
        util.format("%o", { a: 1 }),
        util.format("%O", { a: { b: { c: { d: 1 } } } }),
        util.format("%c styled", "color: red"),
        util.format("100%% %s"),
        util.format("%s"),
        util.format("a", "b", 3, { c: 1 }),
        util.format(1, 2),
        util.format("%s", null, undefined),
        util.format("%x %s", "y")
    ]);
    same("formatWithOptions", ({ util }) =>
        util.formatWithOptions({ compact: false }, "%O", { a: 1 })
    );
});

suite("shim util - functions", () => {
    same("promisify", async ({ util }) => {
        const ok = util.promisify(
            (a: number, cb: (e: null, r: number) => void) => cb(null, a + 1)
        );
        const fail = util.promisify((cb: (e: Error) => void) =>
            cb(new TypeError("no"))
        );
        return [await ok(1), await fail().catch((e: Error) => e.name)];
    });
    same("promisify.custom", ({ util }) => {
        const fn: any = () => {};
        const custom = () => Promise.resolve("custom");
        fn[util.promisify.custom] = custom;
        return [
            util.promisify(fn) === custom,
            util.promisify.custom === Symbol.for("nodejs.util.promisify.custom")
        ];
    });
    same("promisify rejects a non-function", ({ util }) =>
        util.promisify("x" as any)
    );
    same("callbackify", async ({ util }) => {
        const results: unknown[] = [];
        util.callbackify(async (x: number) => x * 2)(
            2,
            (e: unknown, v: number) => results.push(e, v)
        );
        util.callbackify(async () => {
            throw null;
        })((e: any) => results.push(e?.code, e?.reason));
        await settle();
        return results;
    });
    same("inherits", ({ util }) => {
        function Base() {}
        Base.prototype.hello = () => "hi";
        function Child() {}
        util.inherits(Child, Base);
        return [
            new (Child as any)().hello(),
            (Child as any).super_ === Base,
            Object.getPrototypeOf(Child.prototype) === Base.prototype
        ];
    });
    same("deprecate returns a working function", ({ util }) => {
        const fn = util.deprecate((x: number) => x + 1, "old", "DEP_TEST");
        return [typeof fn, fn(1)];
    });
    same("isDeepStrictEqual", ({ util }) => [
        util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
        util.isDeepStrictEqual([1], ["1"]),
        util.isDeepStrictEqual(new Set([1, 2]), new Set([2, 1])),
        util.isDeepStrictEqual(NaN, NaN),
        util.isDeepStrictEqual(0, -0)
    ]);
    same("debuglog", ({ util }) => {
        const log = util.debuglog("shimtest");
        return [typeof log, typeof log.enabled];
    });
    same("TextEncoder and TextDecoder", ({ util }) => [
        typeof util.TextEncoder,
        typeof util.TextDecoder,
        new util.TextDecoder().decode(new util.TextEncoder().encode("é"))
    ]);
    same("styleText", ({ util }) => util.styleText("red", "x"));
    same("stripVTControlCharacters", ({ util }) =>
        util.stripVTControlCharacters("\u001b[31mred\u001b[39m")
    );
    same(
        "parseArgs",
        ({ util }) =>
            util.parseArgs({
                args: ["-f", "--bar", "b"],
                options: {
                    foo: { type: "boolean", short: "f" },
                    bar: { type: "string" }
                }
            }).values
    );
    same("toUSVString", ({ util }) => util.toUSVString("a\ud800b"));
});

suite("shim util - types", () => {
    const checks = [
        "isAnyArrayBuffer",
        "isArrayBuffer",
        "isArrayBufferView",
        "isAsyncFunction",
        "isBigInt64Array",
        "isBooleanObject",
        "isBoxedPrimitive",
        "isDataView",
        "isDate",
        "isGeneratorFunction",
        "isGeneratorObject",
        "isMap",
        "isMapIterator",
        "isNativeError",
        "isNumberObject",
        "isPromise",
        "isProxy",
        "isRegExp",
        "isSet",
        "isSetIterator",
        "isSharedArrayBuffer",
        "isStringObject",
        "isSymbolObject",
        "isTypedArray",
        "isUint8Array",
        "isFloat32Array",
        "isWeakMap",
        "isWeakSet",
        "isKeyObject",
        "isCryptoKey"
    ];
    const samples = (B: typeof Buffer) => [
        new ArrayBuffer(1),
        new Uint8Array(1),
        B.from("a"),
        new Float32Array(1),
        new BigInt64Array(1),
        new DataView(new ArrayBuffer(1)),
        async () => {},
        function* () {},
        (function* () {})(),
        new Map().keys(),
        new Set().values(),
        new Map(),
        new Set(),
        new WeakMap(),
        new WeakSet(),
        new Date(),
        /x/,
        new Error("e"),
        Promise.resolve(),
        new Proxy({}, {}),
        new Number(1),
        new String("s"),
        new Boolean(true),
        Object(Symbol("s")),
        { then() {} },
        {}
    ];
    for (const check of checks) {
        // a choice, tested on its own below
        if (check === "isProxy") continue;
        same(`types.${check}`, ({ util, Buffer }) =>
            samples(Buffer).map((v) => (util.types as any)[check](v))
        );
    }
    // A page cannot tell a Proxy from its target: isProxy is always false,
    // where Node asks V8 (improvements/shim/conformance.md)
    test("types.isProxy is false: a Proxy cannot be detected from JavaScript", () => {
        assert.equal(shim.util.types.isProxy(new Proxy({}, {})), false);
        assert.equal(shim.util.types.isProxy({}), false);
    });
    same(
        "util/types matches util.types",
        () =>
            Object.keys(libUtilTypes).filter((k) => k.startsWith("is")).length >
            0
    );
});
