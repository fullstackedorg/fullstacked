import test, { suite, before, after } from "node:test";
import assert from "node:assert";
import { type Browser, type Page } from "puppeteer";
import { launchBrowser } from "../../browser.ts";
import { fileURLToPath } from "node:url";
import createDOMPurify from "dompurify";
import * as lib from "../../../core/internal/bundle/lib/DOMParser/index.ts";
import { check, normalize } from "../common.ts";
import {
    COMMON,
    PAYLOADS,
    sanitizeAll,
    unsafeParts
} from "../../dompurify/corpus.ts";

// Node has no DOMParser: the oracle is the browser's, where the webview's
// main thread gets its parser. Each case is a function of the DOM globals,
// run on the TypeScript parser of lib/DOMParser (what workers get) and in
// headless Chrome; the results must be plain data. A case gets `dump` (a
// node as nested arrays: type, name, namespace, attributes, value or
// children) and an optional argument, so that it can be run on a list of
// inputs; it is sent to the page as source, so it uses nothing else.

type Dom = {
    DOMParser: typeof DOMParser;
    XMLSerializer: typeof XMLSerializer;
    Node: typeof Node;
    dump: (node: Node) => unknown;
};
type Case = (dom: Dom, arg?: any) => unknown;

function dump(node: Node): unknown {
    if (node.nodeType === 1) {
        const element = node as Element;
        return [
            1,
            element.nodeName,
            element.namespaceURI,
            Array.from(element.attributes).map((a) => [
                a.name,
                a.namespaceURI,
                a.prefix,
                a.localName,
                a.value
            ]),
            Array.from(element.childNodes).map(dump)
        ];
    }
    if (node.nodeType === 9) {
        return [9, Array.from(node.childNodes).map(dump)];
    }
    if (node.nodeType === 10) {
        const doctype = node as DocumentType;
        return [10, doctype.name, doctype.publicId, doctype.systemId];
    }
    return [node.nodeType, node.nodeName, node.nodeValue];
}

const ours = { ...(lib as unknown as Dom), dump };
let browser: Browser;
let page: Page;

async function inBrowser(fn: Case, arg: unknown) {
    return page.evaluate(`(() => {
        const dump = ${dump.toString()};
        try {
            return {
                value: (${fn.toString()})(
                    { DOMParser, XMLSerializer, Node, dump },
                    ${JSON.stringify(arg)}
                )
            };
        } catch (e) {
            return { error: { name: e.name } };
        }
    })()`);
}

function inNode(fn: Case, arg: unknown) {
    try {
        return {
            value: JSON.parse(JSON.stringify(normalize(fn(ours, arg)) ?? null))
        };
    } catch (e) {
        return { error: { name: (e as Error).name } };
    }
}

function same(name: string, fn: Case, arg?: unknown) {
    check("DOMParser", name, async () => {
        assert.deepStrictEqual(inNode(fn, arg), await inBrowser(fn, arg));
    });
}

// each input parsed, as a tree and serialized
const parseEach: Case = ({ DOMParser, XMLSerializer, dump }, inputs) =>
    inputs.map((xml: string) => {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        return [dump(doc), new XMLSerializer().serializeToString(doc)];
    });

// malformed input: whether it is a parse error, the parsed tree when it is
// not. The parsererror document itself (libxml's message, how much it
// recovered) changes with the browser's version and is left aside.
const parseOrError: Case = ({ DOMParser, XMLSerializer, dump }, inputs) =>
    inputs.map((xml: string) => {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        if (doc.getElementsByTagName("parsererror").length > 0) {
            return "parsererror";
        }
        return [dump(doc), new XMLSerializer().serializeToString(doc)];
    });

suite("shim DOMParser (the TypeScript parser against the browser)", () => {
    before(async () => {
        browser = await launchBrowser({ headless: true });
        page = await browser.newPage();
    });
    after(() => browser?.close());

    // DOMPurify given the DOM of lib/DOMParser as a window, as a worker or a
    // fullstacked --file script would (test/dompurify), against DOMPurify on
    // the browser's DOM: the same output for the same input and options, and
    // nothing of the payloads left that the browser would run
    suite("DOMPurify", () => {
        let browserResults: Record<string, string>;
        let ourResults: Record<string, string>;
        const cases = [...COMMON, ...PAYLOADS];
        before(async () => {
            await page.addScriptTag({
                path: fileURLToPath(
                    new URL(
                        "../../../node_modules/dompurify/dist/purify.min.js",
                        import.meta.url
                    )
                )
            });
            browserResults = (await page.evaluate(
                `(${sanitizeAll.toString()})(DOMPurify, ${JSON.stringify(cases)})`
            )) as Record<string, string>;
            const document = new lib.DOMParser().parseFromString(
                "<!DOCTYPE html>",
                "text/html"
            );
            const purify = createDOMPurify({ ...lib, document } as any);
            assert.equal(purify.isSupported, true);
            ourResults = sanitizeAll(purify, cases);
        });
        for (const c of COMMON) {
            check("DOMPurify", `same output: ${c.name}`, () =>
                assert.equal(ourResults[c.name], browserResults[c.name])
            );
        }
        for (const c of PAYLOADS) {
            check("DOMPurify", `safe: ${c.name}`, async () => {
                const found = await page.evaluate(
                    `(${unsafeParts.toString()})(${JSON.stringify(ourResults[c.name])}, DOMParser)`
                );
                assert.deepEqual(found, [], ourResults[c.name]);
                assert.deepEqual(
                    unsafeParts(ourResults[c.name], lib.DOMParser),
                    [],
                    ourResults[c.name]
                );
            });
        }
        test("payloads: the browser's output, mostly", (t) => {
            const differ = PAYLOADS.filter(
                (c) => ourResults[c.name] !== browserResults[c.name]
            );
            // where the trees differ (no form named properties to clobber,
            // noscript's content in the lenient parser) both are safe
            // (above); the output is the browser's for the rest
            for (const c of differ) {
                t.diagnostic(
                    `${c.name}: ${ourResults[c.name]} (browser: ${browserResults[c.name]})`
                );
            }
            assert.ok(differ.length <= PAYLOADS.length / 4);
        });
    });

    test("browser oracle is reachable", async () => {
        assert.equal(await page.evaluate("typeof DOMParser"), "function");
    });

    same("documentElement, namespace and children", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Contents id="1" class="item"><Key>photos/a &amp; b.jpg</Key><Size>10</Size></Contents>
</ListBucketResult>`,
            "text/xml"
        );
        const root = doc.documentElement;
        return [
            root.nodeName,
            root.localName,
            root.namespaceURI,
            root.childNodes.length,
            Array.from(root.childNodes).map((n) => n.nodeType)
        ];
    });
    same(
        "getElementsByTagName and textContent with entities",
        ({ DOMParser }) => {
            const doc = new DOMParser().parseFromString(
                `<r><Key>a &amp; b &lt;c&gt; &#233; &#x20AC;</Key><Key>two</Key></r>`,
                "text/xml"
            );
            return Array.from(doc.getElementsByTagName("Key")).map(
                (k) => k.textContent
            );
        }
    );
    same("attributes", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r a="1" b='two' c="&quot;q&quot;" xmlns:x="urn:x" x:d="ns"/>`,
            "text/xml"
        );
        const r = doc.documentElement;
        return [
            r.getAttribute("a"),
            r.getAttribute("b"),
            r.getAttribute("c"),
            r.getAttribute("missing"),
            r.getAttributeNS("urn:x", "d"),
            r.hasAttribute("a"),
            r.attributes.length
        ];
    });
    same("getElementsByTagNameNS", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r xmlns:a="urn:a"><a:x>1</a:x><x>2</x><a:x>3</a:x></r>`,
            "text/xml"
        );
        return [
            Array.from(doc.getElementsByTagNameNS("urn:a", "x")).map(
                (e) => e.textContent
            ),
            Array.from(doc.getElementsByTagNameNS("*", "x")).length,
            Array.from(doc.getElementsByTagName("a:x")).length,
            Array.from(doc.documentElement.getElementsByTagName("*")).length
        ];
    });
    same("CDATA, comments and processing instructions", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<?xml version="1.0"?><?pi data?><r><![CDATA[<raw> & ]]><!-- c --></r>`,
            "text/xml"
        );
        return [
            Array.from(doc.childNodes).map((n) => [n.nodeType, n.nodeName]),
            Array.from(doc.documentElement.childNodes).map((n) => [
                n.nodeType,
                n.nodeValue
            ])
        ];
    });
    same(
        "CDATA, comment and PI content",
        ({ DOMParser, XMLSerializer, dump }) => {
            const doc = new DOMParser().parseFromString(
                `<r>a<![CDATA[ <b> & ]] ]]]]><![CDATA[]]>c<!----><!-- - < & -->` +
                    `<?t  data with ? and > ?><?u?><?xml-stylesheet href="s"?></r>`,
                "text/xml"
            );
            const pi = doc.documentElement
                .childNodes[6] as ProcessingInstruction;
            return [
                dump(doc),
                doc.documentElement.textContent,
                [pi.target, pi.data],
                new XMLSerializer().serializeToString(doc)
            ];
        }
    );
    same("whitespace text nodes are kept", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r>\n  <a/>\n</r>`,
            "text/xml"
        );
        return Array.from(doc.documentElement.childNodes).map(
            (n) => n.nodeType
        );
    });
    same("element navigation", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r><a/>t<b/></r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        return [
            r.firstChild.nodeName,
            r.lastChild.nodeName,
            r.firstChild.nextSibling.nodeValue,
            (r.lastChild as Element).parentNode.nodeName,
            r.childElementCount,
            r.firstElementChild?.nodeName,
            r.children?.length
        ];
    });
    same("children and element siblings", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r>x<a/><!--c--><b id="b"/>y<c/>z</r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        const b = doc.getElementById("b");
        const text = r.firstChild as Text;
        return [
            Array.from(r.children).map((e) => e.nodeName),
            r.children.item(1).nodeName,
            r.lastElementChild.nodeName,
            b.previousElementSibling.nodeName,
            b.nextElementSibling.nodeName,
            b.previousSibling.nodeName,
            text.nextElementSibling.nodeName,
            r.firstElementChild.previousElementSibling,
            r.lastElementChild.nextElementSibling,
            b.parentElement.nodeName,
            r.parentElement,
            r.parentNode.nodeName,
            doc.getElementById("missing"),
            r.childNodes.item(0).nodeValue,
            r.childNodes.item(99)
        ];
    });
    same("XML declaration and document properties", ({ DOMParser }) =>
        [
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><r/>`,
            `<?xml version='1.0' standalone='no' ?><r/>`,
            `<r/>`
        ].map((xml) => {
            // the XML declaration properties are not in lib.dom's Document
            const doc: any = new DOMParser().parseFromString(xml, "text/xml");
            return [
                doc.xmlVersion,
                doc.xmlEncoding,
                doc.xmlStandalone,
                doc.contentType,
                doc.characterSet,
                doc.nodeName,
                doc.nodeValue,
                doc.textContent,
                doc.ownerDocument,
                doc.documentElement.ownerDocument === doc,
                Object.prototype.toString.call(doc),
                Object.prototype.toString.call(doc.documentElement),
                Object.prototype.toString.call(doc.childNodes)
            ];
        })
    );
    same("node types and constants", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<!DOCTYPE r><r a="1">t<![CDATA[c]]><!--m--><?p d?></r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        const nodes = [doc, doc.doctype, r, r.attributes[0], ...r.childNodes];
        return [
            nodes.map((n) => [n.nodeType, n.nodeName, n.nodeValue]),
            [r.ELEMENT_NODE, r.TEXT_NODE, r.DOCUMENT_NODE],
            r.childNodes[0].constructor.name,
            r.childNodes[1].constructor.name
        ];
    });
    same(
        "character references, decimal, hex and astral",
        ({ DOMParser, XMLSerializer }) => {
            const doc = new DOMParser().parseFromString(
                `<r a="&#x1F600;&#60;&#x3E;">&#x1F600;&#128512;&#65;&#x41;&#x0000041;&#9;&#xa;&#xD;&#xe9;&#8364;&#x10FFFF;&lt;&gt;&amp;&quot;&apos;</r>`,
                "text/xml"
            );
            const r = doc.documentElement;
            return [
                r.textContent,
                r.textContent.length,
                r.childNodes.length,
                r.getAttribute("a"),
                new XMLSerializer().serializeToString(doc)
            ];
        }
    );
    same("attribute value normalization", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(
            `<r a="x\ty\nz\r\nw\rv  u" b="&#9;&#10;&#13; &#32;" c=" lead and trail " d="&lt;&amp;&gt;'&quot;" e='"'/>`,
            "text/xml"
        );
        const r = doc.documentElement;
        return [
            ["a", "b", "c", "d", "e"].map((n) => r.getAttribute(n)),
            new XMLSerializer().serializeToString(doc)
        ];
    });
    same("line ends in text", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(
            `<r>a\r\nb\rc\n\rd&#13;e<![CDATA[f\r\ng]]><!--h\r\ni--></r>`,
            "text/xml"
        );
        return [
            doc.documentElement.textContent,
            new XMLSerializer().serializeToString(doc)
        ];
    });
    same("namespaces and prefix redefinition", ({ DOMParser, dump }) => {
        const doc = new DOMParser().parseFromString(
            `<r xmlns="urn:d" xmlns:p="urn:p" a="1" p:b="2">` +
                `<p:c xmlns:p="urn:q" p:x="3"><p:in/></p:c><p:after/>` +
                `<d xmlns=""><e/></d><f xml:lang="en"/></r>`,
            "text/xml"
        );
        const inner = doc.getElementsByTagName("p:in")[0];
        const e = doc.getElementsByTagName("e")[0];
        return [
            dump(doc),
            [inner.prefix, inner.localName, inner.namespaceURI],
            [
                inner.lookupNamespaceURI("p"),
                inner.lookupNamespaceURI(null),
                e.lookupNamespaceURI(null),
                inner.lookupPrefix("urn:q"),
                doc.documentElement.lookupPrefix("urn:p"),
                inner.isDefaultNamespace("urn:d"),
                inner.lookupNamespaceURI("xml")
            ]
        ];
    });
    same("default namespace is not applied to attributes", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r xmlns="urn:d" xmlns:d="urn:d" a="1" d:a="2"/>`,
            "text/xml"
        );
        const r = doc.documentElement;
        return [
            r.namespaceURI,
            Array.from(r.attributes).map((a) => [a.name, a.namespaceURI]),
            r.getAttributeNS(null, "a"),
            r.getAttributeNS("urn:d", "a"),
            r.getAttribute("d:a"),
            r.hasAttributeNS("urn:d", "a"),
            r.attributes.getNamedItemNS("urn:d", "a").value,
            r.attributes.getNamedItem("a").value
        ];
    });
    same("DOCTYPE skipped", parseEach, [
        `<!DOCTYPE r><r/>`,
        `<!DOCTYPE r SYSTEM "r.dtd"><r/>`,
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html/>`
    ]);
    // an internal subset is skipped; its declarations are not applied
    // (Chrome applies ATTLIST defaults and ENTITY definitions, and where a
    // comment in it lands depends on its version): the root element only
    same("DOCTYPE internal subset skipped", ({ DOMParser, dump }) => {
        const doc = new DOMParser().parseFromString(
            `<?xml version="1.0"?>\n<!DOCTYPE r [\n  <!ELEMENT r (#PCDATA)>\n  <!-- ] -->\n  <?pi ]?>\n  <!ENTITY % p "]>">\n]>\n<r>t</r>`,
            "text/xml"
        );
        return [doc.doctype?.name, dump(doc.documentElement)];
    });
    same("whitespace and markup around the root element", parseEach, [
        `\n\n<r/>\n\n`,
        `<!-- before --><?p before?>\n<r/>\n<!-- after --><?p after?>`
    ]);
    same("XMLSerializer round trip", ({ DOMParser, XMLSerializer }) => {
        const xml = `<r xmlns="urn:r" a="1"><b>x &amp; y</b><c/><![CDATA[z]]></r>`;
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        return new XMLSerializer().serializeToString(doc);
    });
    same(
        "XMLSerializer of a subtree and of other nodes",
        ({ DOMParser, XMLSerializer }) => {
            const doc = new DOMParser().parseFromString(
                `<r xmlns="urn:r" xmlns:p="urn:p"><p:a><b x="1">t&lt;</b></p:a><!--c--></r>`,
                "text/xml"
            );
            const s = new XMLSerializer();
            const r = doc.documentElement;
            return [
                s.serializeToString(r.firstChild),
                s.serializeToString(doc.getElementsByTagName("b")[0]),
                s.serializeToString(
                    doc.getElementsByTagName("b")[0].firstChild
                ),
                s.serializeToString(r.lastChild)
            ];
        }
    );
    same("serializer escaping", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(`<r/>`, "text/xml");
        const r = doc.documentElement;
        const e = doc.createElement("e");
        e.setAttribute("a", `\t\n\r<>&"' \u00a0`);
        e.appendChild(doc.createTextNode(`\r\n<>&"' \u00a0]]>`));
        r.appendChild(e);
        r.appendChild(doc.createComment("c--d"));
        r.appendChild(doc.createProcessingInstruction("t", "x y"));
        r.appendChild(doc.createProcessingInstruction("u", ""));
        r.appendChild(doc.createCDATASection("a]]b<&"));
        return new XMLSerializer().serializeToString(doc);
    });
    same(
        "serializer namespaces of a DOM-built tree",
        ({ DOMParser, XMLSerializer }) => {
            const doc = new DOMParser().parseFromString(
                `<r xmlns="urn:d"/>`,
                "text/xml"
            );
            const r = doc.documentElement;
            r.appendChild(doc.createElement("plain"));
            r.appendChild(doc.createElementNS("urn:d", "same"));
            const p = doc.createElementNS("urn:p", "p:el");
            p.setAttributeNS("urn:p", "p:a", "1");
            p.setAttributeNS("urn:q", "q:b", "2");
            p.appendChild(doc.createElementNS("urn:p", "p:child"));
            p.appendChild(doc.createElementNS("urn:other", "other"));
            r.appendChild(p);
            const x = doc.createElementNS(null, "x");
            x.setAttributeNS(
                "http://www.w3.org/XML/1998/namespace",
                "xml:lang",
                "en"
            );
            r.appendChild(x);
            return new XMLSerializer().serializeToString(doc);
        }
    );
    same("DOM edits then serialize", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(`<r/>`, "text/xml");
        const e = doc.createElement("child");
        e.setAttribute("k", "v<");
        e.appendChild(doc.createTextNode("t&"));
        doc.documentElement.appendChild(e);
        return new XMLSerializer().serializeToString(doc);
    });
    same("DOM edits", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(
            `<r><a/><b/><c/></r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        const kids = r.childNodes;
        const [a, b, c] = Array.from(kids);
        const log: unknown[] = [];
        const names = () =>
            Array.from(kids)
                .map((n) => n.nodeName)
                .join();
        const x = doc.createElement("x");
        r.insertBefore(x, b);
        log.push(
            names(),
            kids.length,
            x.previousSibling.nodeName,
            x.nextSibling.nodeName
        );
        r.insertBefore(c, a);
        log.push(names(), c.previousSibling, a.previousSibling.nodeName);
        log.push(r.replaceChild(doc.createElement("y"), a).nodeName, names());
        log.push(a.parentNode, a.previousSibling, a.nextSibling);
        log.push(r.removeChild(b).nodeName, names(), r.lastChild.nodeName);
        r.appendChild(x);
        log.push(names(), r.firstChild.nodeName, x.nextSibling);
        b.appendChild(a);
        a.appendChild(doc.createTextNode("t"));
        r.appendChild(b);
        log.push(
            names(),
            r.textContent,
            r.hasChildNodes(),
            a.firstChild.hasChildNodes()
        );
        const fragment = doc.createDocumentFragment();
        fragment.appendChild(doc.createElement("f1"));
        fragment.appendChild(doc.createElement("f2"));
        r.insertBefore(fragment, r.firstChild);
        log.push(names(), fragment.childNodes.length);
        a.remove();
        r.append("s", doc.createElement("z"));
        r.prepend(doc.createComment("p"));
        log.push(names(), r.contains(a), r.contains(x), r.contains(r));
        return [log, new XMLSerializer().serializeToString(doc)];
    });
    same("DOM errors", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(`<r><a/></r>`, "text/xml");
        const r = doc.documentElement;
        const a = r.firstChild as Element;
        const attempt = (fn: () => unknown) => {
            try {
                fn();
                return "ok";
            } catch (e) {
                return (e as Error).name;
            }
        };
        return [
            attempt(() => a.appendChild(r)),
            attempt(() => a.appendChild(a)),
            attempt(() => r.removeChild(doc.createElement("x"))),
            attempt(() =>
                r.insertBefore(doc.createElement("x"), doc.createElement("y"))
            ),
            attempt(() => doc.appendChild(doc.createElement("second"))),
            attempt(() => doc.appendChild(doc.createTextNode("t"))),
            attempt(
                () =>
                    r.firstChild.appendChild(doc.createTextNode("t")) &&
                    r.firstChild.firstChild.appendChild(doc.createTextNode("u"))
            ),
            attempt(() => doc.createElement("1a")),
            attempt(() => doc.createElement("a b")),
            attempt(() => doc.createElementNS(null, "p:a")),
            attempt(() => doc.createElementNS("urn:x", "xml:a")),
            attempt(() => a.setAttribute("=", "v")),
            attempt(() => doc.createCDATASection("]]>")),
            attempt(() => doc.createProcessingInstruction("p", "?>")),
            attempt(() => r.appendChild("text" as any)),
            attempt(() =>
                new DOMParser().parseFromString("<r/>", "text/plain" as any)
            )
        ];
    });
    same("textContent set", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(
            `<r><a>x<b>y</b></a><c>z</c><d/></r>`,
            "text/xml"
        );
        const [a, c, d] = Array.from(doc.documentElement.children);
        a.textContent = "1 < 2 & 3";
        c.textContent = "";
        d.textContent = null;
        const text = a.firstChild as Text;
        text.textContent = text.textContent + "!";
        (doc as any).textContent = "ignored";
        return [
            a.childNodes.length,
            c.childNodes.length,
            text.data,
            text.length,
            doc.documentElement.textContent,
            new XMLSerializer().serializeToString(doc)
        ];
    });
    same("nodeValue and character data", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r a="1">text<!--c--></r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        const text = r.firstChild as Text;
        const comment = r.lastChild as Comment;
        const attr = r.getAttributeNode("a");
        r.nodeValue = "ignored";
        text.nodeValue = "abcdef";
        text.appendData("g");
        text.insertData(0, "_");
        text.deleteData(1, 2);
        text.replaceData(0, 1, "X");
        comment.data = "d";
        attr.value = "2";
        const tail = text.splitText(3);
        return [
            r.nodeValue,
            text.data,
            tail.data,
            text.substringData(1, 2),
            text.wholeText,
            comment.nodeValue,
            r.getAttribute("a"),
            attr.nodeValue,
            attr.textContent,
            attr.ownerElement.nodeName,
            attr.specified,
            r.childNodes.length
        ];
    });
    same("attribute methods", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(
            `<r xmlns:p="urn:p" a="1" p:b="2"/>`,
            "text/xml"
        );
        const r = doc.documentElement;
        r.setAttribute("a", "one");
        r.setAttribute("c", "3");
        r.setAttributeNS("urn:p", "p:b", "two");
        r.setAttributeNS("urn:p", "q:d", "4");
        r.setAttributeNS(null, "e", "5");
        const before = r.getAttributeNames();
        r.removeAttribute("c");
        r.removeAttributeNS("urn:p", "d");
        r.removeAttribute("missing");
        const attr = doc.createAttribute("f");
        attr.value = "6";
        r.setAttributeNode(attr);
        return [
            before,
            r.getAttributeNames(),
            r.hasAttributes(),
            r.attributes.item(0).name,
            r.attributes.item(9),
            r.attributes.getNamedItem("p:b").value,
            r.getAttributeNodeNS("urn:p", "b").prefix,
            r.hasAttribute("c"),
            r.hasAttributeNS("urn:p", "d"),
            attr.ownerElement === r,
            new XMLSerializer().serializeToString(doc)
        ];
    });
    same("cloneNode deep and shallow", ({ DOMParser, XMLSerializer }) => {
        const doc = new DOMParser().parseFromString(
            `<r xmlns:p="urn:p"><p:a x="1">t<b/><!--c--></p:a></r>`,
            "text/xml"
        );
        const a = doc.documentElement.firstChild as Element;
        const shallow = a.cloneNode() as Element;
        const deep = a.cloneNode(true) as Element;
        deep.setAttribute("x", "2");
        deep.firstChild.nodeValue = "changed";
        const s = new XMLSerializer();
        const docCopy = doc.cloneNode(true) as Document;
        return [
            s.serializeToString(shallow),
            s.serializeToString(deep),
            s.serializeToString(a),
            [shallow.parentNode, deep.parentNode, deep.ownerDocument === doc],
            [deep.namespaceURI, deep.prefix, deep.childNodes.length],
            [docCopy.documentElement.nodeName, docCopy === doc],
            s.serializeToString(docCopy),
            s.serializeToString(a.firstChild.cloneNode())
        ];
    });
    same("normalize", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r>a<![CDATA[b]]><e>c</e></r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        const e = r.lastChild as Element;
        r.insertBefore(doc.createTextNode("x"), r.childNodes[1]);
        r.insertBefore(doc.createTextNode(""), r.firstChild);
        e.appendChild(doc.createTextNode("d"));
        e.appendChild(doc.createTextNode(""));
        r.normalize();
        return [
            Array.from(r.childNodes).map((n) => [n.nodeType, n.nodeValue]),
            Array.from(e.childNodes).map((n) => n.nodeValue)
        ];
    });
    same("createDocument", ({ DOMParser, XMLSerializer }) => {
        const impl = new DOMParser().parseFromString(
            `<r/>`,
            "text/xml"
        ).implementation;
        const doctype = impl.createDocumentType("p:root", "pub", "sys");
        const doc = impl.createDocument("urn:p", "p:root", doctype);
        doc.documentElement.appendChild(doc.createElementNS("urn:p", "p:a"));
        const empty = impl.createDocument(null, null, null);
        return [
            new XMLSerializer().serializeToString(doc),
            doc.documentElement.namespaceURI,
            doc.doctype.name,
            doc.contentType,
            Object.prototype.toString.call(doc),
            empty.childNodes.length,
            empty.documentElement,
            impl.hasFeature()
        ];
    });
    same("malformed XML", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(`<r><a></r>`, "text/xml");
        return [
            doc.getElementsByTagName("parsererror").length > 0,
            doc.documentElement?.nodeName
        ];
    });
    same("malformed: tags", parseOrError, [
        `<r><a></r>`,
        `<r>\n  <a>\n    <b>t</c>\n</r>`,
        `<a><b><c></a>`,
        `<r xmlns:p="u"><p:a></p:b></r>`,
        `<r>text`,
        `<r><a>t</a><b>`,
        `<r><a>xy</b></r>`,
        `<r>x<`,
        `<r>ab<c a`,
        `<r/><s/>`,
        `</r>`,
        `< r/>`,
        `<r></>`
    ]);
    same("malformed: attributes", parseOrError, [
        `<r a=1/>`,
        `<r a="1" a="2"/>`,
        `<r><s xmlns:p="u" xmlns:q="u" p:a="1" q:a="2"/></r>`,
        `<r a="1"b="2"/>`,
        `<r a/>`,
        `<r a="<"/>`,
        `<r a="x`,
        `<r><s a='&foo;'/></r>`
    ]);
    same("malformed: references and characters", parseOrError, [
        `<r>&foo;</r>`,
        `<r>a &amp b</r>`,
        `<r>&;</r>`,
        `<r>&#xZZ;</r>`,
        `<r>&#12a;</r>`,
        `<r>&#0;</r>`,
        `<r>&#1114112;</r>`,
        `<r>&#xD800;</r>`,
        `<r>\u0001</r>`,
        `<r>a\uFFFE</r>`,
        `<r>a]]>b</r>`,
        `<r>é😀&x;</r>`,
        `<r>\r\n\r\n  &x;</r>`
    ]);
    // a BOM before the root and <xml:r/> are left out: libxml's versions
    // disagree on them
    same("malformed: outside the root element", parseOrError, [
        ``,
        `  `,
        `abc`,
        `<r>x</r>junk`,
        `<r/>&amp;`,
        `<!-- c -->`,
        `<?xml version="1.0"?>`,
        ` <?xml version="1.0"?><r/>`,
        `<r><?xml version="1.0"?></r>`,
        `<![CDATA[a]]><r/>`,
        `<r/><!DOCTYPE r>`,
        `<!-- c --><?p?><!DOCTYPE r><r a=1/>`
    ]);
    same("malformed: markup", parseOrError, [
        `<r><!-- a -- b --></r>`,
        `<r><!-- x</r>`,
        `<r><![CDATA[x</r>`,
        `<r><?p x</r>`,
        `<r><? p?></r>`,
        `<r><!- a --></r>`,
        `<!doctype r><r/>`,
        `<?xml encoding="UTF-8"?><r/>`
    ]);
    same("malformed: namespaces", parseOrError, [
        `<r><x:a/></r>`,
        `<r x:a="1"/>`,
        `<r xmlns:p=""/>`,
        `<r xmlns:xmlns="u"/>`,
        `<r xmlns="http://www.w3.org/2000/xmlns/"/>`,
        `<r><:a/></r>`,
        `<r><a:/></r>`
    ]);
    same("XHTML elements serialize as in HTML", parseEach, [
        `<html xmlns="http://www.w3.org/1999/xhtml"><p/><br/><hr></hr><img><b/></img><script>a&lt;b</script></html>`
    ]);

    // "text/html": the lenient parser at the level of xmldom's HTML mode
    // (lib/DOMParser/parse.ts parseHTML). Its own behavior is pinned with the
    // expected values (the content of <body>, with the DOCTYPE); the browser
    // is the oracle for what both do alike, its implied <tbody> left aside.
    suite("text/html", () => {
        const XHTML = "http://www.w3.org/1999/xhtml";
        const X = ` xmlns="${XHTML}"`;
        const parse = (html: string) =>
            new ours.DOMParser().parseFromString(html, "text/html");
        const serialize = (node: Node) =>
            new ours.XMLSerializer().serializeToString(node);
        // the DOCTYPE and the content of <body>, serialized
        const bodyMarkup = (doc: Document) =>
            [doc.doctype, ...doc.body.childNodes]
                .filter((node) => node !== null)
                .map(serialize)
                .join("");
        // input -> serialization of the document
        const serializations = (cases: [string, string][]) => {
            for (const [html, expected] of cases) {
                assert.equal(bodyMarkup(parse(html)), expected, html);
            }
        };

        test("elements closed implicitly", () =>
            serializations([
                [
                    `<p>one<p>two<div>three</div>`,
                    `<p${X}>one</p><p${X}>two</p><div${X}>three</div>`
                ],
                [
                    `<ul><li>a<li>b<ul><li>c</ul><li>d</ul>`,
                    `<ul${X}><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>`
                ],
                [
                    `<dl><dt>t<dd>d<p>e<dt>u</dl>`,
                    `<dl${X}><dt>t</dt><dd>d<p>e</p></dd><dt>u</dt></dl>`
                ],
                [
                    `<select><option>a<option>b<optgroup><option>c</select>`,
                    `<select${X}><option>a</option><option>b</option><optgroup><option>c</option></optgroup></select>`
                ],
                // no implied <tbody>
                [
                    `<table><tr><td>1<td>2<tr><th>3</table>`,
                    `<table${X}><tr><td>1</td><td>2</td></tr><tr><th>3</th></tr></table>`
                ],
                [
                    `<table><thead><tr><th>h<tbody><tr><td>a<tfoot><tr><td>f</table>`,
                    `<table${X}><thead><tr><th>h</th></tr></thead><tbody><tr><td>a</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>`
                ],
                [
                    `<table><tr><td><table><tr><td>in</table><td>out</table>`,
                    `<table${X}><tr><td><table><tr><td>in</td></tr></table></td><td>out</td></tr></table>`
                ],
                [`<h1>a<h2>b`, `<h1${X}>a</h1><h2${X}>b</h2>`],
                [
                    `<a href=1>x<a href=2>y`,
                    `<a${X} href="1">x</a><a${X} href="2">y</a>`
                ],
                [
                    `<button>a<button>b`,
                    `<button${X}>a</button><button${X}>b</button>`
                ],
                // a <table> stays in a <p> in quirks mode (no DOCTYPE html)
                [
                    `<p>a<table><tr><td>x</table>`,
                    `<p${X}>a<table><tr><td>x</td></tr></table></p>`
                ],
                [
                    `<!DOCTYPE html><p>a<table><tr><td>x</table>`,
                    `<!DOCTYPE html><p${X}>a</p><table${X}><tr><td>x</td></tr></table>`
                ]
            ]));

        test("end tags: stray, misnested, in any case", () =>
            serializations([
                [`</div><p>a</span>b</P>`, `<p${X}>ab</p>`],
                // an inline end tag does not close a block
                [
                    `<span><div>a</span>b</div>`,
                    `<span${X}><div>ab</div></span>`
                ],
                [
                    `<div><table><tr><td>x</div>y</table>z`,
                    `<div${X}><table><tr><td>xy</td></tr></table>z</div>`
                ],
                // no reconstruction of misnested formatting (the browser
                // makes y an <i> too)
                [`<b><i>x</b>y</i>`, `<b${X}><i>x</i></b>y`],
                // the browser's exceptions: </br> is <br>, a stray </p> is <p>
                [`<p>a</br>b</p>`, `<p${X}>a<br />b</p>`],
                [`<div>a</p>b</div>`, `<div${X}>a<p></p>b</div>`],
                [
                    `<DIV>a</div><Span>b</SPAN>`,
                    `<div${X}>a</div><span${X}>b</span>`
                ]
            ]));

        test("void elements", () =>
            serializations([
                [
                    `<div>a<br>b<img src=x.png><br/>c<input disabled><wbr><col><param name=p></div>`,
                    `<div${X}>a<br />b<img src="x.png" /><br />c<input disabled="" /><wbr /><col /><param name="p" /></div>`
                ],
                // "/>" on an element that is not void is ignored
                [`<div/>text<span/>t`, `<div${X}>text<span>t</span></div>`]
            ]));

        test("raw text: script, style, textarea, title, plaintext", () => {
            const doc = parse(
                `<div><script>if (a < b && c > d) x = "</p><b>";</SCRIPT ><style>p > a { }</style>` +
                    `<textarea>\nx &lt; <i>y</i></textarea><title>a &amp; <b></title>` +
                    `<pre>\nkept\n</pre><xmp><b>&amp;</b></xmp></div><plaintext><b>&amp;</b></div>`
            );
            assert.deepEqual(
                Array.from(doc.body.getElementsByTagName("*")).map((e) => [
                    e.localName,
                    e.childNodes.length,
                    e.textContent
                ]),
                [
                    [
                        "div",
                        6,
                        `if (a < b && c > d) x = "</p><b>";p > a { }x < <i>y</i>a & <b>kept\n<b>&amp;</b>`
                    ],
                    ["script", 1, `if (a < b && c > d) x = "</p><b>";`],
                    ["style", 1, "p > a { }"],
                    ["textarea", 1, "x < <i>y</i>"],
                    ["title", 1, "a & <b>"],
                    ["pre", 1, "kept\n"],
                    ["xmp", 1, "<b>&amp;</b>"],
                    ["plaintext", 1, "<b>&amp;</b></div>"]
                ]
            );
            // the text is escaped: the output is XML
            assert.equal(
                serialize(doc.getElementsByTagName("script")[0]),
                `<script${X}>if (a &lt; b &amp;&amp; c &gt; d) x = "&lt;/p&gt;&lt;b&gt;";</script>`
            );
        });

        test("character references", () => {
            const text = (html: string) =>
                parse(html).documentElement.textContent;
            assert.equal(
                text(
                    `<p>&nbsp;&copy;&reg;&amp;&lt;&gt;&quot;&apos;&hellip;&mdash;&ndash;&laquo;&raquo;&euro;&eacute;&times;&larr;&hearts;&alpha;&lang;</p>`
                ),
                ` ©®&<>"'…—–«»€é×←♥α⟨`
            );
            // the legacy forms without semicolon, the longest one in text
            assert.equal(
                text(`<p>&copy2026 &amp chips &notit; &AMP; &COPY;</p>`),
                "©2026 & chips ¬it; & ©"
            );
            assert.equal(
                text(
                    `<p>&#65;&#x42;&#X43;&#0;&#x80;&#xD800;&#1114112;&#65x&#x1F600;</p>`
                ),
                "ABC�€��Ax😀"
            );
            // unknown or malformed: kept as written (HTML5's names outside
            // the table of entities.ts too)
            assert.equal(
                text(
                    `<p>&unknown; &bogus &; &# &#x; & x &NotSquareSuperset;</p>`
                ),
                "&unknown; &bogus &; &# &#x; & x &NotSquareSuperset;"
            );
            // in an attribute, a legacy reference followed by "=" or a letter
            // stays (query strings)
            assert.equal(
                parse(
                    `<a href="?a=1&copy=2&lang=en&amp;b&copy;c&copy d">`
                ).body.firstElementChild.getAttribute("href"),
                "?a=1&copy=2&lang=en&b©c© d"
            );
        });

        test("attributes", () => {
            const input = parse(
                `<INPUT Type=Text value='a "b"' disabled data-x="1" DATA-X="2" title=a&amp;b/c x= y/>`
            ).body.firstElementChild;
            assert.deepEqual(
                Array.from(input.attributes).map((a) => [
                    a.name,
                    a.namespaceURI,
                    a.value
                ]),
                [
                    ["type", null, "Text"],
                    ["value", null, `a "b"`],
                    ["disabled", null, ""],
                    ["data-x", null, "1"],
                    ["title", null, "a&b/c"],
                    ["x", null, "y/"]
                ]
            );
            assert.equal(input.getAttribute("TYPE"), "Text");
            assert.equal(input.hasAttribute("Disabled"), true);
            input.setAttribute("NEW", "n");
            assert.deepEqual(input.getAttributeNames().slice(-1), ["new"]);
        });

        test("names, namespace and document", () => {
            const doc = parse(`<DIV Class=A><x:y>t</x:y><Span>s</Span></DIV>`);
            const div = doc.body.firstElementChild;
            assert.deepEqual(dump(doc), [
                9,
                [
                    [
                        1,
                        "HTML",
                        XHTML,
                        [],
                        [
                            [1, "HEAD", XHTML, [], []],
                            [
                                1,
                                "BODY",
                                XHTML,
                                [],
                                [
                                    [
                                        1,
                                        "DIV",
                                        XHTML,
                                        [["class", null, null, "class", "A"]],
                                        [
                                            [
                                                1,
                                                "X:Y",
                                                XHTML,
                                                [],
                                                [[3, "#text", "t"]]
                                            ],
                                            [
                                                1,
                                                "SPAN",
                                                XHTML,
                                                [],
                                                [[3, "#text", "s"]]
                                            ]
                                        ]
                                    ]
                                ]
                            ]
                        ]
                    ]
                ]
            ]);
            assert.deepEqual(
                [div.tagName, div.localName, div.prefix, div.namespaceURI],
                ["DIV", "div", null, XHTML]
            );
            assert.equal(String(doc), "[object HTMLDocument]");
            assert.equal(doc.contentType, "text/html");
            assert.equal(doc.getElementsByTagName("SPAN").length, 1);
            assert.equal(doc.getElementsByTagName("x:Y").length, 1);
            const created = doc.createElement("SeCtIoN");
            assert.deepEqual(
                [created.tagName, created.localName, created.namespaceURI],
                ["SECTION", "section", XHTML]
            );
            const clone = doc.cloneNode(true) as Document;
            assert.equal(String(clone), "[object HTMLDocument]");
            assert.equal(clone.contentType, "text/html");
            // an element moved into an XML document is named as there
            const xml = new ours.DOMParser().parseFromString(
                `<r/>`,
                "text/xml"
            );
            assert.equal(xml.importNode(div, true).tagName, "div");
        });

        test("document: DOCTYPE, comments and the top-level nodes", () => {
            const doc = parse(
                `<!DOCTYPE html>\n<!-- c --><html lang=en><head><title>t</title></head><body><p>x</body></html>\n` +
                    `<?xml version="1.0"?><!x></ y><!-->`
            );
            assert.deepEqual(
                Array.from(doc.childNodes).map((n) => [n.nodeType, n.nodeName]),
                [
                    [10, "html"],
                    [3, "#text"],
                    [8, "#comment"],
                    [1, "HTML"],
                    [3, "#text"],
                    [8, "#comment"],
                    [8, "#comment"],
                    [8, "#comment"],
                    [8, "#comment"]
                ]
            );
            assert.equal(doc.documentElement.tagName, "HTML");
            assert.equal(
                serialize(doc),
                `<!DOCTYPE html>\n<!-- c --><html${X} lang="en"><head><title>t</title></head><body><p>x</p></body></html>\n` +
                    `<!--?xml version="1.0"?--><!--x--><!-- y--><!---->`
            );
            // several elements and text at the top: in <body>
            assert.deepEqual(
                Array.from(parse(`a<p>b</p>c<p>d`).body.childNodes).map((n) => [
                    n.nodeName,
                    n.textContent
                ]),
                [
                    ["#text", "a"],
                    ["P", "b"],
                    ["#text", "c"],
                    ["P", "d"]
                ]
            );
            assert.deepEqual(
                dump(
                    parse(
                        `<!doctype HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">`
                    )
                ),
                [
                    9,
                    [
                        [
                            10,
                            "html",
                            "-//W3C//DTD HTML 4.01//EN",
                            "http://www.w3.org/TR/html4/strict.dtd"
                        ],
                        [
                            1,
                            "HTML",
                            XHTML,
                            [],
                            [
                                [1, "HEAD", XHTML, [], []],
                                [1, "BODY", XHTML, [], []]
                            ]
                        ]
                    ]
                ]
            );
        });

        test("SVG and MathML", () => {
            const doc = parse(
                `<div><svg viewBox="0 0 1 1"><use xlink:href="#a"/><linearGradient id=g /><foreignObject><p>x</p></foreignObject><![CDATA[a<b]]></svg><math><mi>x</mi></math></div>`
            );
            assert.equal(
                serialize(doc.body.firstChild),
                `<div${X}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/><linearGradient id="g"/><foreignObject><p${X}>x</p></foreignObject>a&lt;b</svg><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></div>`
            );
            const use = doc.getElementsByTagName("use")[0];
            assert.equal(
                use.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
                "#a"
            );
        });

        test("never a parsererror", () => {
            for (const html of [
                ``,
                `<`,
                `</`,
                `<p`,
                `<p a="`,
                `<!--`,
                `<!DOCTYPE`,
                `<script>`,
                `<textarea>&`,
                `&`,
                `a < b > c`,
                `</p></p></html>`,
                `<p><b><i><u>x</p></u></i></b>`,
                `<<>><//><!>`,
                `<?xml version="1.0"?><r/>`,
                `<x:y a:b="1"/>`,
                `\u0000￾\uD800`
            ]) {
                const doc = parse(html);
                assert.equal(
                    doc.getElementsByTagName("parsererror").length,
                    0,
                    html
                );
            }
        });

        // what both parsers give for the content of the browser's <body>
        // (all of our document)
        const bodyOf: Case = ({ DOMParser, XMLSerializer, dump }, inputs) =>
            inputs.map((html: string) => {
                const doc = new DOMParser().parseFromString(html, "text/html");
                // our document's DOCTYPE is in the browser's document
                const nodes = (
                    Array.from((doc.body ?? doc).childNodes) as Node[]
                ).filter((n) => n.nodeType !== 10);
                return [
                    nodes.map(dump),
                    nodes
                        .map((n) => new XMLSerializer().serializeToString(n))
                        .join("")
                ];
            });
        same("elements and implied end tags as the browser", bodyOf, [
            `<p>a<br>b`,
            `<P CLASS=x>Hi</p>`,
            `<div class=card><h2 class="title">Hello <em>World</em></h2><p>One<p>Two<ul><li><a href=/a>A</a><li><a href='/b?x=1&amp;y=2'>B</a></ul><img src=x.png alt=""><br></div>`,
            `<ul><li>a<li>b</ul>`,
            `<ol><li>a<ol><li>b<li>c</ol><li>d</ol>`,
            `<ul><li>a</li>\n<li>b</li>\n</ul>`,
            `<dl><dt>T<dd>D<p>para<dt>T2</dl>`,
            `<div><p>a<div>b</div></div>`,
            `<blockquote><p>q<blockquote>r</blockquote></blockquote>`,
            `<select><option>a<option>b</select>`,
            `<option>a<optgroup>b<option>c`,
            `<h1>a<h2>b</h2>`,
            `<p>x<hr>y`,
            `<button>a<button>b`,
            `<a href=1>x<a href=2>y`,
            `<table><tbody><tr><td>a<tbody><tr><td>b</table>`,
            `<table><thead><tr><th>h1<th>h2<tbody><tr><td>a<td>b<tr><td>c<td>d<tfoot><tr><td>f</table>`,
            `<!DOCTYPE html><p>a<table><tbody><tr><td>x</table>`
        ]);
        same("end tags as the browser", bodyOf, [
            `<p>a<b>c</p>`,
            `</div><p>a</p>`,
            `<p>a</span>b</p>`,
            `<span><div>a</span>b</div>`,
            `<span>a<p>b</span>c</p>`,
            `<div><p>a</div>b`,
            `<p>x</P><DIV>y</div>`,
            `<p>a</br>b</p>`,
            `<div>a</p>b</div>`
        ]);
        same("void elements, attributes and case as the browser", bodyOf, [
            `<img src=a.png><hr><br/>`,
            `<input disabled value=abc type='text'>`,
            `<form action=/s method=post><input type=checkbox checked><input name=q value="a &quot;b&quot;"><select name=s><option value=1 selected>One<option value=2>Two</select><textarea name=t>x &lt; y</textarea><button type=submit>Go</button></form>`,
            `<DIV ID=Main><SPAN Class=A>t</SPAN></DIV>`,
            `<iMg SrC="A.PNG">`,
            `<p a=1 a=2 B=3>`,
            `<div data-x='{"a":1}' aria-label="L" hidden>z</div>`,
            `<input value="a\nb" title=a&lt;b>`,
            `<div/>text`,
            `<x:y>a</x:y>`,
            `<div xmlns="urn:x">a</div>`
        ]);
        same("raw text as the browser", bodyOf, [
            `<div><script>if (a < b && c > d) x = '</p>';</script><style>a>b{}</style><p></p></div>`,
            `<div><script type="text/javascript">var s = '<div>' + "</scr" + "ipt>"; if (a<b) {}</script></div>`,
            `<div><title>a &amp; <b></title></div>`,
            `<textarea>&lt;b&gt; <i></textarea>`,
            `<textarea>\nline</textarea><pre>\nx</pre><pre>\n\ny</pre>`,
            `<plaintext><b>x</b>`,
            `<iframe><b>y</b></iframe><xmp><b>z</b></xmp>`
        ]);
        same("character references as the browser", bodyOf, [
            `<p>&nbsp;&copy;&reg;&hellip;&mdash;&euro;&unknown;&amp &lt</p>`,
            `<p>caf&eacute; &lt;tag&gt; 5 &times; 3 &ne; 15 &larr; &hearts; &#x1F600; &#128512;</p>`,
            `<p>Fish &amp chips &amp; more &AMP; &COPY; &copy;right</p>`,
            `<p>&copy2026 &notit; &amp= <a title='&copy=1 &copyx &copy;x'>`,
            `<p>&#65;&#x42;&#0;&#x80;&#xD800;&#1114112;&#; &#x; &#65x</p>`,
            `<a href="x?a=1&b=2">l</a>`,
            `<a href="?a=1&lang=en&copy=2&not=3">q</a>`,
            `<p>trailing &amp`
        ]);
        same("text, comments and the end of the input as the browser", bodyOf, [
            `text only`,
            `a < b <3 </> </ x> <!x> <?xml v?>`,
            `x<!--->y<!-- a -- b -->`,
            `<p>unterminated <b attr="x`,
            `<p>unterminated <b`,
            `<p>x<!-- unterminated`
        ]);
        same("SVG and MathML as the browser", bodyOf, [
            `<svg><circle r=1></circle></svg>`,
            `<svg viewBox='0 0 1 1'><foreignObject><p>x</p></foreignObject><path d=M0/><title>t</title></svg>`,
            `<math><mi>x</mi></math>`,
            `<svg><![CDATA[a<b]]></svg><![CDATA[c]]>`,
            `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>`
        ]);
        same(
            "a whole document as the browser",
            ({ DOMParser, XMLSerializer, dump }, inputs) =>
                inputs.map((html: string) => {
                    const doc = new DOMParser().parseFromString(
                        html,
                        "text/html"
                    );
                    return [
                        dump(doc),
                        new XMLSerializer().serializeToString(doc)
                    ];
                }),
            [
                `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T &amp; t</title><link rel=stylesheet href=a.css></head><body><p>x<p>y</body></html>`,
                `<!doctype HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html><head><title>t</title></head><body></body></html>`
            ]
        );
        same("the DOM of an HTML document as the browser", ({ DOMParser }) => {
            const doc = new DOMParser().parseFromString(
                `<!DOCTYPE html><html><head></head><body><P ID=a Class=c>x</P><p>y</p><svg><g/></svg></body></html>`,
                "text/html"
            );
            const p = doc.getElementsByTagName("p")[0];
            const created = doc.createElement("DiV");
            created.setAttribute("ABC", "1");
            const ns = doc.createElementNS(
                "http://www.w3.org/1999/xhtml",
                "Q:Foo"
            );
            const svg = doc.createElementNS(
                "http://www.w3.org/2000/svg",
                "Circle"
            );
            return [
                Object.prototype.toString.call(doc),
                doc.contentType,
                doc.documentElement.tagName,
                [p.tagName, p.localName, p.nodeName, p.namespaceURI],
                [
                    doc.getElementsByTagName("P").length,
                    doc.getElementsByTagName("p").length,
                    doc.getElementsByTagName("G").length,
                    doc.getElementsByTagName("g").length,
                    p.getAttribute("CLASS"),
                    p.getAttribute("id"),
                    p.hasAttribute("Id")
                ],
                [
                    created.tagName,
                    created.localName,
                    created.getAttributeNames()
                ],
                [ns.tagName, ns.localName, ns.prefix],
                [svg.tagName, svg.localName],
                Object.prototype.toString.call(doc.cloneNode(true)),
                (doc.cloneNode(false) as Document).contentType
            ];
        });
    });

    // what HTML libraries use beyond parsing: the document's head, body and
    // title, innerHTML and outerHTML, createHTMLDocument, NodeIterator
    same("head, body and title", ({ DOMParser }) =>
        [
            `<title> A  b </title><p>x`,
            `<!DOCTYPE html><html><head><meta charset=utf-8></head><body class=c>y</body></html>`,
            `<html><p>z`,
            `<!-- c -->\n  <link rel=x><script>s</script>\n<p>w</p>`,
            ``
        ].map((html) => {
            const doc = new DOMParser().parseFromString(html, "text/html");
            return [
                doc.title,
                doc.head.childNodes.length,
                Array.from(doc.head.childNodes).map((n) => n.nodeName),
                doc.body.innerHTML,
                doc.documentElement.childNodes.length,
                doc.childNodes.length
            ];
        })
    );
    same("innerHTML and outerHTML", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<div id=d class="a b" title='x"y&amp;z<w>'>a &amp; b&nbsp;<br><img src=x.png alt=""><!--c--><script>if (a<b) x="&amp;"</script><style>a>b{}</style><textarea>&lt;t&gt;</textarea><svg viewBox="0 0 1 1"><circle r="1"/></svg><p>x</p></div>`,
            "text/html"
        );
        const div = doc.body.firstElementChild;
        const before = [div.innerHTML, div.outerHTML];
        div.innerHTML = `<b>new</b> text<i>i`;
        const set = [div.innerHTML, div.childNodes.length];
        div.firstElementChild.outerHTML = `<u>u</u><s>s</s>`;
        const replaced = div.innerHTML;
        const script = doc.createElement("script");
        script.innerHTML = `<b>raw</b>`;
        return [
            before,
            set,
            replaced,
            script.childNodes.length,
            script.innerHTML
        ];
    });
    same("innerHTML in an XML document", ({ DOMParser }) => {
        const doc = new DOMParser().parseFromString(
            `<r xmlns="urn:r"><a b="1">t &amp; <c/></a></r>`,
            "text/xml"
        );
        const r = doc.documentElement;
        const before = r.innerHTML;
        r.innerHTML = `<n>x</n>`;
        let error = null;
        try {
            r.innerHTML = `<unclosed>`;
        } catch (e) {
            error = (e as Error).name;
        }
        return [
            before,
            (r.firstChild as Element).namespaceURI,
            r.innerHTML,
            error
        ];
    });
    same("createHTMLDocument", ({ DOMParser }) => {
        const impl = new DOMParser().parseFromString(
            "",
            "text/html"
        ).implementation;
        const doc = impl.createHTMLDocument("T");
        const blank = impl.createHTMLDocument();
        doc.body.innerHTML = `<p>x</p>`;
        return [
            doc.documentElement.outerHTML,
            doc.title,
            doc.doctype.name,
            blank.head.childNodes.length,
            Object.prototype.toString.call(doc)
        ];
    });
    same(
        "createNodeIterator, with nodes removed and added",
        ({ DOMParser }) => {
            const doc = new DOMParser().parseFromString(
                `<div><p>a<b>b</b></p><!--c--><i>i<u>u</u></i>t<s>s</s></div>`,
                "text/html"
            );
            const div = doc.body.firstChild as Element;
            const names = (whatToShow: number, filter: any) => {
                const it = doc.createNodeIterator(div, whatToShow, filter);
                const out = [];
                for (let n = it.nextNode(); n; n = it.nextNode())
                    out.push(n.nodeName);
                const back = [];
                for (let n = it.previousNode(); n; n = it.previousNode()) {
                    back.push(n.nodeName);
                }
                return [out, back];
            };
            // what DOMPurify does: remove the current node, its content moved
            // after it
            const it = doc.createNodeIterator(div, 0x1 | 0x4 | 0x80, null);
            const seen = [];
            for (let n: any = it.nextNode(); n; n = it.nextNode()) {
                seen.push(n.nodeName);
                if (n.nodeName === "I") {
                    for (const child of Array.from(n.childNodes)) {
                        n.parentNode.insertBefore(child, n.nextSibling);
                    }
                    n.remove();
                }
                if (n.nodeName === "S") n.parentNode.removeChild(n);
            }
            return [
                names(0xffffffff, null),
                names(0x1, null),
                names(0x4 | 0x80, null),
                names(0x1, (n: Node) => (n.nodeName === "B" ? 3 : 1)),
                names(0x1, {
                    acceptNode: (n: Node) => (n.nodeName === "P" ? 2 : 1)
                }),
                seen,
                div.innerHTML,
                [
                    it.root === div,
                    it.whatToShow,
                    it.filter,
                    it.referenceNode.nodeName
                ]
            ];
        }
    );
    same("Node.prototype getters on any node", ({ DOMParser, Node }) => {
        const doc = new DOMParser().parseFromString(
            `<p a=1>t<!--c--></p>`,
            "text/html"
        );
        const p = doc.body.firstChild as Element;
        const get = (proto: object, name: string, node: unknown) =>
            Object.getOwnPropertyDescriptor(proto, name).get.call(node);
        const nodes = [p, p.firstChild, p.lastChild, doc, p.attributes[0]];
        return nodes.map((n) => [
            get(Node.prototype, "nodeType", n),
            get(Node.prototype, "nodeName", n),
            get(Node.prototype, "nodeValue", n),
            get(Node.prototype, "textContent", n)
        ]);
    });

    // no selector engine on the worker's DOM (improvements/shim/plan.md 5.4)
    test("querySelector is not provided", () => {
        const doc = new ours.DOMParser().parseFromString(
            `<r><a/></r>`,
            "text/xml"
        );
        assert.equal((doc as any).querySelector, undefined);
        assert.equal((doc.documentElement as any).querySelector, undefined);
    });
});
