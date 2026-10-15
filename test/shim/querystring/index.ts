import { suite } from "node:test";
import nodeQuerystring from "node:querystring";
import libQuerystring from "../../../core/internal/bundle/lib/querystring/index.ts";
import { sameFor } from "../common.ts";

type QuerystringModule = typeof nodeQuerystring;
const shim = libQuerystring as unknown as QuerystringModule;
const node = nodeQuerystring;
const same = sameFor<QuerystringModule>("querystring", shim, node);

const QUERIES = [
    "",
    "a=1&b=2",
    "a=1&a=2&a=3",
    "a&b=&=c&&d=1",
    "q=hello+world&x=%20%2B%26",
    "bad=%E0%A4%A&ok=%41",
    "utf=%E2%82%AC%F0%9F%98%80",
    "a[b]=1&a[c]=2",
    "__proto__=1&constructor=2&hasOwnProperty=3",
    "a=1;b=2",
    "key=val=ue"
];

suite("shim querystring", () => {
    for (const query of QUERIES) {
        same(`parse ${JSON.stringify(query)}`, ({ parse }) =>
            Object.entries(parse(query))
        );
    }
    same(
        "parse returns a null-prototype object",
        ({ parse }) => Object.getPrototypeOf(parse("a=1")) === null
    );
    same("parse with sep, eq and maxKeys", ({ parse }) => [
        Object.entries(parse("a:1;b:2;c:3", ";", ":")),
        Object.entries(parse("a=1&b=2&c=3", null, null, { maxKeys: 2 })),
        Object.entries(parse("a=1&b=2", "&", "=", { maxKeys: 0 }))
    ]);
    same("parse with decodeURIComponent", ({ parse }) =>
        Object.entries(
            parse("a=%41", null, null, {
                decodeURIComponent: (s: string) => s.toLowerCase()
            })
        )
    );
    same("stringify", ({ stringify }) => [
        stringify({ a: 1, b: "two", c: true }),
        stringify({ a: [1, 2], b: "" }),
        stringify({ sp: "a b", amp: "&=", utf: "€😀", q: "'!()*~" }),
        stringify({
            n: null,
            u: undefined,
            o: { x: 1 } as any,
            big: 10n as any
        }),
        stringify({ nan: NaN, inf: Infinity }),
        stringify({ a: 1, b: 2 }, ";", ":"),
        stringify("text" as any),
        stringify({ a: "x" }, null, null, {
            encodeURIComponent: (s: string) => s.toUpperCase()
        })
    ]);
    same("stringify a lone surrogate", ({ stringify }) =>
        stringify({ a: "\ud800" })
    );
    same("escape and unescape", ({ escape, unescape }) => [
        escape("a b&c/€"),
        unescape("a%20b%26c"),
        unescape("%E0%A4%A"),
        unescape("a+b")
    ]);
    same("unescapeBuffer", (qs) => (qs as any).unescapeBuffer("a%20b%zz"));
    same(
        "decode and encode aliases",
        ({ decode, encode, parse, stringify }) => [
            decode === parse,
            encode === stringify
        ]
    );
});
