import { suite } from "node:test";
import nodeAssert from "node:assert";
import * as libAssert from "../../../core/internal/bundle/lib/assert/index.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import { sameFor } from "../common.ts";

type AssertModule = typeof nodeAssert;
type Env = { assert: AssertModule; Buffer: typeof Buffer };
const shim: Env = {
    assert: ((libAssert as any).default ?? libAssert) as AssertModule,
    Buffer: (libBuffer as any).Buffer
};
const node: Env = { assert: nodeAssert, Buffer };
const same = sameFor<Env>("assert", shim, node);

// pass, or the AssertionError fields that do not depend on the message
function verdict(fn: () => unknown) {
    try {
        fn();
        return "pass";
    } catch (e: any) {
        return {
            name: e?.name,
            code: e?.code,
            operator: e?.operator,
            generatedMessage: e?.generatedMessage
        };
    }
}

class A {
    x = 1;
}
class B {
    x = 1;
}

// pairs that loose and strict equality judge differently or that the
// deep-equality algorithm of Node handles specially
function pairs(Buf: typeof Buffer): [string, unknown, unknown][] {
    const sym = Symbol("s");
    return [
        ["1 and '1'", 1, "1"],
        ["NaN and NaN", NaN, NaN],
        ["0 and -0", 0, -0],
        ["null and undefined", null, undefined],
        ["objects with number and string", { a: 1 }, { a: "1" }],
        ["arrays in order", [1, 2, [3]], [1, 2, [3]]],
        ["sparse and undefined", [1, , 3], [1, undefined, 3]],
        [
            "maps in another order",
            new Map([
                ["a", 1],
                ["b", 2]
            ]),
            new Map([
                ["b", 2],
                ["a", 1]
            ])
        ],
        ["sets with objects", new Set([{ a: 1 }, 2]), new Set([2, { a: 1 }])],
        ["map with loose values", new Map([["a", 1]]), new Map([["a", "1"]])],
        ["dates", new Date(0), new Date(0)],
        ["different dates", new Date(0), new Date(1)],
        ["regexps with flags", /a/g, /a/i],
        ["same regexps", /a/g, /a/g],
        ["boxed and primitive", new Number(1), 1],
        ["boxed values", new String("a"), new String("a")],
        ["different classes", new A(), new B()],
        [
            "null prototype",
            Object.assign(Object.create(null), { x: 1 }),
            { x: 1 }
        ],
        ["symbol keys", { [sym]: 1 }, { [sym]: 2 }],
        ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
        ["typed array kinds", new Uint8Array([1]), new Int8Array([1])],
        ["buffer and Uint8Array", Buf.from([1]), new Uint8Array([1])],
        ["errors with messages", new Error("a"), new Error("b")],
        ["errors", new TypeError("a"), new TypeError("a")],
        ["-0 in arrays", [0], [-0]],
        ["non-enumerable", Object.defineProperty({}, "x", { value: 1 }), {}],
        [
            "getter values",
            {
                get x() {
                    return 1;
                }
            },
            { x: 1 }
        ],
        ["weakmaps", new WeakMap(), new WeakMap()]
    ];
}

const OPERATORS = [
    "equal",
    "notEqual",
    "strictEqual",
    "notStrictEqual",
    "deepEqual",
    "notDeepEqual",
    "deepStrictEqual",
    "notDeepStrictEqual"
] as const;

suite("shim assert - equality", () => {
    for (const [name] of pairs(Buffer)) {
        same(`equality matrix: ${name}`, ({ assert, Buffer }) => {
            const [, a, b] = pairs(Buffer).find(([n]) => n === name);
            return OPERATORS.map((op) => [
                op,
                verdict(() => (assert as any)[op](a, b))
            ]);
        });
    }
    same("circular structures", ({ assert }) => {
        const a: any = { x: 1 };
        a.self = a;
        const b: any = { x: 1 };
        b.self = b;
        return [verdict(() => assert.deepStrictEqual(a, b))];
    });
});

suite("shim assert - API", () => {
    same("ok, assert(), fail", ({ assert }) => [
        verdict(() => (assert as (v: unknown) => void)(1)),
        verdict(() => (assert as (v: unknown) => void)(0)),
        verdict(() => assert.ok("")),
        verdict(() => assert.fail()),
        verdict(() => assert.fail("msg"))
    ]);
    same("a custom message and an Error as message", ({ assert }) => {
        const custom = new RangeError("custom");
        let thrown: unknown;
        try {
            (assert.strictEqual as (...args: unknown[]) => void)(1, 2, custom);
        } catch (e) {
            thrown = e;
        }
        return [thrown === custom, verdict(() => assert.equal(1, 2, "mine"))];
    });
    same("AssertionError fields", ({ assert }) => {
        try {
            (assert.strictEqual as (...args: unknown[]) => void)(1, 2);
        } catch (e: any) {
            return [
                e instanceof assert.AssertionError,
                e.actual,
                e.expected,
                e.operator,
                e.code
            ];
        }
    });
    same("new AssertionError", ({ assert }) => {
        const e = new assert.AssertionError({
            actual: 1,
            expected: 2,
            operator: "==="
        });
        return [
            e.name,
            e.code,
            e.actual,
            e.expected,
            e.operator,
            e.generatedMessage
        ];
    });
    same("throws with validators", ({ assert }) => {
        const thrower = () => {
            throw new TypeError("bad value");
        };
        return [
            verdict(() => assert.throws(thrower)),
            verdict(() => assert.throws(thrower, TypeError)),
            verdict(() => assert.throws(thrower, RangeError)),
            verdict(() => assert.throws(thrower, /bad/)),
            verdict(() => assert.throws(thrower, /good/)),
            verdict(() =>
                assert.throws(thrower, {
                    name: "TypeError",
                    message: "bad value"
                })
            ),
            verdict(() => assert.throws(thrower, { message: /val/ })),
            verdict(() =>
                assert.throws(thrower, (e: Error) => e instanceof TypeError)
            ),
            verdict(() => assert.throws(() => {})),
            verdict(() => assert.doesNotThrow(() => {})),
            verdict(() => assert.doesNotThrow(thrower))
        ];
    });
    same("rejects and doesNotReject", async ({ assert }) => {
        const settle = (p: Promise<unknown>) =>
            p.then(
                () => "pass",
                (e: any) => ({ name: e?.name, code: e?.code })
            );
        return [
            await settle(
                assert.rejects(Promise.reject(new TypeError("x")), TypeError)
            ),
            await settle(assert.rejects(Promise.resolve(1))),
            await settle(
                assert.rejects(async () => {
                    throw new Error("y");
                }, /y/)
            ),
            await settle(assert.doesNotReject(Promise.resolve(1))),
            await settle(assert.doesNotReject(Promise.reject(new Error("z"))))
        ];
    });
    same("match and doesNotMatch", ({ assert }) => [
        verdict(() => assert.match("abc", /b/)),
        verdict(() => assert.match("abc", /x/)),
        verdict(() => assert.doesNotMatch("abc", /x/)),
        verdict(() => assert.doesNotMatch("abc", /b/))
    ]);
    same("ifError", ({ assert }) => [
        verdict(() => assert.ifError(null)),
        verdict(() => assert.ifError(undefined)),
        verdict(() => assert.ifError(new Error("e"))),
        verdict(() => assert.ifError("text"))
    ]);
    same("assert.strict", ({ assert }) => [
        typeof assert.strict,
        assert.strict.strict === assert.strict,
        verdict(() => assert.strict.equal(1, "1" as any)),
        verdict(() => assert.strict.deepEqual({ a: 1 }, { a: "1" }))
    ]);
    same("partialDeepStrictEqual", ({ assert }) =>
        verdict(() =>
            (assert as any).partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 })
        )
    );
});
