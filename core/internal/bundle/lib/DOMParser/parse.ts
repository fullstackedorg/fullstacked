// A non-validating XML 1.0 parser with namespaces (improvements/shim/plan.md 3.2, 5.4):
// elements, attributes, text, CDATA sections, comments, processing
// instructions, the XML declaration, a DOCTYPE (kept as a DocumentType node;
// its internal subset is skipped, so only the five predefined entities and
// character references are expanded) and the well-formedness errors.
//
// Written for speed: the scanner looks for delimiters with indexOf and reads
// characters with charCodeAt, takes every string out of the input with one
// slice (never character by character), allocates nothing for an element
// without attributes or namespace declarations beyond its node, and builds
// the tree as it goes with the links set directly (dom.ts appendParsed).
// The two regular expressions run once per document, before the scan.
//
// Errors produce what Chrome's DOMParser produces (the conformance oracle,
// test/shim/DOMParser): the document as parsed up to the error, with a
// <parsererror> element of the XHTML namespace as the first child of the
// root element, or, when there is no root element yet, as the content of
// <html><body> (the prolog before it is kept). It holds an <h3>, a <div>
// with "error on line L at column C: message" and another <h3>. Line and
// column are counted in characters (code points) from 1, and the messages
// are Chrome's for the errors a document usually has: mismatched or
// unclosed tags, duplicate or malformed attributes, unknown entities,
// unbound prefixes, content outside the root element. A text run cut by an
// error in the markup that follows it is left as an empty Text node, as
// Chrome does.
//
// Different from Chrome: the declarations of the internal subset are not
// applied, so an entity declared there is not expanded (a reference to one
// is an "Unexpected entity" error) and an ATTLIST default value is not
// added; some rare errors (in the XML declaration, the DOCTYPE, names with
// a misplaced colon) can be reported with another message or column.
//
// parseHTML, at the end of this file, is the lenient parser of "text/html"
// (the level of xmldom's HTML mode, which DOMParser had before Stage 6): it
// never fails, and its header says what it does of the HTML rules.

import {
    Attr,
    CDATASection,
    Comment,
    DocumentType,
    Element,
    HTMLDocument,
    MATHML_NS,
    NAME_CHARS,
    type Node,
    ProcessingInstruction,
    SVG_NS,
    Text,
    XHTML_NS,
    XLINK_NS,
    XML_NS,
    XMLDocument,
    XMLNS_NS,
    appendParsed,
    asciiLower,
    asciiUpper,
    isNameCharNonAscii,
    isNameStartNonAscii
} from "./dom.ts";
import { HTML_ENTITIES, LEGACY_ENTITIES } from "./entities.ts";

const LT = 0x3c; // <
const GT = 0x3e; // >
const AMP = 0x26; // &
const SLASH = 0x2f; // /
const BANG = 0x21; // !
const QUESTION = 0x3f; // ?
const EQUALS = 0x3d; // =
const QUOTE = 0x22; // "
const APOSTROPHE = 0x27; // '
const HASH = 0x23; // #
const SEMICOLON = 0x3b; // ;
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;

// the characters XML 1.0 does not allow anywhere, CR aside (it is
// normalized away before this runs); lone surrogates are replaced first
const INVALID_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

const PREDEFINED_ENTITIES: Record<string, string> = Object.assign(
    Object.create(null),
    { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }
);

const PARSERERROR_STYLE =
    "display: block; white-space: pre; border: 2px solid #c77; padding: 0 1em 0 1em; margin: 1em; background-color: #fdd; color: black";

function isWhitespace(c: number) {
    return c === SPACE || c === LF || c === TAB;
}

function isNameStart(c: number) {
    return c < 128 ? NAME_CHARS[c] === 1 : isNameStartNonAscii(c);
}

// NaN (charCodeAt past the end) is not a name character: name scans stop at
// the end of the input without a bounds check
function isNameChar(c: number) {
    return c < 128 ? NAME_CHARS[c] !== 0 : isNameCharNonAscii(c);
}

function isXmlChar(c: number) {
    return (
        c === TAB ||
        c === LF ||
        c === 0x0d ||
        (c >= 0x20 && c <= 0xd7ff) ||
        (c >= 0xe000 && c <= 0xfffd) ||
        (c >= 0x10000 && c <= 0x10ffff)
    );
}

class ParseError {
    message: string;
    index: number;
    constructor(message: string, index: number) {
        this.message = message;
        this.index = index;
    }
}

// The prefixes in scope: an object per element that declares some, whose
// prototype is the parent's, so a lookup walks up the declarations.
// `default` is the default namespace (null when none).
type Scope = {
    default: string | null;
    prefixes: Record<string, string>;
};

const ROOT_PREFIXES: Record<string, string> = Object.assign(
    Object.create(null),
    { xml: XML_NS }
);

// The attributes of the start tag being read, reused from tag to tag
const attrNames: string[] = [];
const attrValues: string[] = [];
const attrStarts: number[] = []; // index of the name, for the errors
const attrEnds: number[] = []; // index of the closing quote

export function parseXML(input: string, contentType: string): XMLDocument {
    // line ends are normalized before parsing (XML 1.0, 2.11), which also
    // keeps the counts of line and column of the errors right
    if (input.indexOf("\r") !== -1) input = input.replace(/\r\n?/g, "\n");
    // as when the browser converts the string for its parser
    if (typeof input.isWellFormed === "function" && !input.isWellFormed()) {
        input = input.toWellFormed();
    }
    const doc = new XMLDocument();
    doc.contentType = contentType;
    const parser = new Parser(input, doc);
    try {
        parser.run();
    } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        parser.recover();
        insertParserError(doc, input, e);
    }
    return doc;
}

class Parser {
    // the input, cut before the first invalid character if any: reaching
    // its end there reports that character
    s: string;
    invalidAt: number;
    invalidCode = 0;
    pos = 0;
    doc: XMLDocument;

    // the open elements and their namespace scopes; parent is where the
    // next node goes (the document outside the root element)
    stack: Element[] = [];
    scopes: Scope[] = [];
    parent: Node;
    scope: Scope = { default: null, prefixes: ROOT_PREFIXES };
    rootSeen = false;
    doctypeSeen = false;

    // a text run is appended when the markup after it has been read
    // without error (pendingText), and left empty when that markup fails
    // once it has been recognized (identified), as Chrome does
    pendingText: string | null = null;
    identified = false;

    // the next "&" and "]]>" at or after the text being read: found once
    // and reused until the scan passes them, so that a document without
    // any is searched once, not once per text node
    nextAmp = -1;
    nextCdataEnd = -1;

    // end of the last reference read by reference()
    refEnd = 0;

    constructor(input: string, doc: XMLDocument) {
        this.doc = doc;
        this.parent = doc;
        const invalid = input.search(INVALID_CHAR);
        this.invalidAt = invalid;
        if (invalid !== -1) this.invalidCode = input.charCodeAt(invalid);
        this.s = invalid === -1 ? input : input.slice(0, invalid);
    }

    run() {
        const s = this.s;
        if (s.startsWith("<?xml") && isWhitespace(s.charCodeAt(5))) {
            this.xmlDeclaration();
        }
        for (;;) {
            const pos = this.pos;
            const lt = s.indexOf("<", pos);
            const stop = lt === -1 ? s.length : lt;
            if (stop > pos) {
                if (this.stack.length === 0) this.outsideRoot(pos, stop);
                else this.pendingText = this.text(pos, stop);
            }
            // a text run cut by the end of the input, or a lone "<" there,
            // is dropped: no markup was recognized after it
            this.identified = lt !== -1 && lt + 1 < s.length;
            if (lt === -1) return this.end();
            const c = s.charCodeAt(lt + 1);
            if (c === SLASH) this.endTag(lt);
            else if (c === BANG) this.markupDeclaration(lt);
            else if (c === QUESTION) this.processingInstruction(lt);
            else this.startTag(lt);
        }
    }

    // after an error: the text run cut by it
    recover() {
        if (this.pendingText !== null && this.identified) {
            appendParsed(this.parent, new Text(this.doc, ""));
        }
    }

    fail(message: string, index: number): never {
        throw new ParseError(message, index);
    }

    // the end of the input where more was expected
    endOfStream(message = "Unexpected end of stream"): never {
        if (this.invalidAt !== -1) this.invalidCharacter();
        this.fail(message, this.s.length);
    }

    // the end of the input inside a start or end tag
    endOfStreamInTag(): never {
        this.endOfStream(
            this.stack.length
                ? "Unexpected end of stream: still inside the root element"
                : "Unexpected end of stream"
        );
    }

    invalidCharacter(): never {
        this.fail(
            `Invalid character ${codePointName(this.invalidCode)}`,
            this.invalidAt
        );
    }

    end() {
        if (this.stack.length) {
            this.endOfStream(
                "Unexpected end of stream: still inside the root element"
            );
        }
        if (this.invalidAt !== -1) this.invalidCharacter();
        if (!this.rootSeen) {
            this.endOfStream("Unexpected end of stream: no root element found");
        }
    }

    // the text before or after the root element: whitespace only
    outsideRoot(start: number, stop: number) {
        const s = this.s;
        for (let i = start; i < stop; i++) {
            const c = s.charCodeAt(i);
            if (isWhitespace(c)) continue;
            if (c === AMP) this.fail("Unexpected token: &", i);
            this.fail(
                "Unexpected characters outside the root element: " +
                    latin1OfUtf8(s.codePointAt(i)),
                i
            );
        }
    }

    // the content of a text run, its references expanded
    text(start: number, stop: number): string {
        const s = this.s;
        if (this.nextAmp < start) {
            const amp = s.indexOf("&", start);
            this.nextAmp = amp === -1 ? Infinity : amp;
        }
        if (this.nextCdataEnd < start) {
            const end = s.indexOf("]]>", start);
            this.nextCdataEnd = end === -1 ? Infinity : end;
        }
        // the common case: nothing to expand
        if (this.nextAmp >= stop && this.nextCdataEnd >= stop) {
            return s.slice(start, stop);
        }
        let out = "";
        let segment = start;
        let amp = this.nextAmp;
        for (;;) {
            if (this.nextCdataEnd < stop && this.nextCdataEnd < amp) {
                this.fail("Unexpected token: ]]>", this.nextCdataEnd);
            }
            if (amp >= stop) break;
            out += s.slice(segment, amp) + this.reference(amp);
            segment = this.refEnd;
            const next = s.indexOf("&", segment);
            amp = next === -1 ? Infinity : next;
        }
        this.nextAmp = amp;
        return out + s.slice(segment, stop);
    }

    // a reference at `amp` ("&name;" or "&#...;"): its text, refEnd after it
    reference(amp: number): string {
        const s = this.s;
        let i = amp + 1;
        const numeric = s.charCodeAt(i) === HASH;
        if (numeric) i++;
        const start = i;
        while (isNameChar(s.charCodeAt(i))) i++;
        if (s.charCodeAt(i) !== SEMICOLON) {
            if (i >= s.length) this.endOfStreamInTag();
            this.fail("Unexpected token inside entity: " + this.tokenAt(i), i);
        }
        const name = s.slice(start, i);
        this.refEnd = i + 1;
        if (numeric) {
            const code = parseCharacterReference(name);
            if (code === -1) this.fail("Invalid numeric entity: " + name, i);
            if (!isXmlChar(code)) {
                this.fail(`Invalid character ${codePointName(code)}`, i);
            }
            return String.fromCodePoint(code);
        }
        if (name === "") this.fail("Encountered empty entity", i);
        const value = PREDEFINED_ENTITIES[name];
        if (value === undefined) {
            this.fail("Unexpected entity: " + name, i);
        }
        return value;
    }

    // what Chrome names the token at i in its messages
    tokenAt(i: number) {
        const s = this.s;
        const c = s.charCodeAt(i);
        if (c === LT && s.charCodeAt(i + 1) === SLASH) return "</";
        return String.fromCodePoint(s.codePointAt(i));
    }

    flushText() {
        if (this.pendingText !== null) {
            appendParsed(this.parent, new Text(this.doc, this.pendingText));
            this.pendingText = null;
        }
    }

    // <name attr="value" ...> or <name .../>
    startTag(lt: number) {
        const s = this.s;
        if (this.stack.length === 0 && this.rootSeen) {
            this.fail("Unexpected token: <", lt);
        }
        const nameStart = lt + 1;
        let i = nameStart;
        let c = s.charCodeAt(i);
        if (!isNameStart(c)) {
            if (i >= s.length) this.endOfStream();
            if (isWhitespace(c) || c === GT || c === SLASH) {
                this.fail("Qualified name is invalid: ", i + 1);
            }
            this.fail(
                "Unexpected token inside qualified name: " + this.tokenAt(i),
                i + 1
            );
        }
        do c = s.charCodeAt(++i);
        while (c < 128 ? NAME_CHARS[c] !== 0 : isNameCharNonAscii(c));
        if (i >= s.length) this.endOfStreamInTag();
        const qname = s.slice(nameStart, i);

        // the attributes, into attrNames/attrValues
        let count = 0;
        let tagEnd: number;
        let selfClosing = false;
        for (;;) {
            const space = i;
            while (isWhitespace(c)) c = s.charCodeAt(++i);
            if (c === GT) {
                tagEnd = i;
                i++;
                break;
            }
            if (c === SLASH) {
                if (s.charCodeAt(i + 1) === GT) {
                    tagEnd = i;
                    selfClosing = true;
                    i += 2;
                    break;
                }
                if (i + 1 >= s.length) this.endOfStreamInTag();
                this.fail(
                    space === i && count === 0
                        ? "Unexpected token inside qualified name: /"
                        : "Unexpected token inside opening tag: /",
                    i
                );
            }
            if (i >= s.length) this.endOfStreamInTag();
            if (space === i || !isNameStart(c)) {
                this.fail(
                    "Unexpected token inside opening tag: " + this.tokenAt(i),
                    i
                );
            }

            const attrStart = i;
            do c = s.charCodeAt(++i);
            while (c < 128 ? NAME_CHARS[c] !== 0 : isNameCharNonAscii(c));
            const name = s.slice(attrStart, i);
            while (isWhitespace(c)) c = s.charCodeAt(++i);
            if (c !== EQUALS) {
                if (i >= s.length) this.endOfStreamInTag();
                this.fail(
                    "Unexpected token inside qualified name: " +
                        (c === SLASH && s.charCodeAt(i + 1) === GT
                            ? "/>"
                            : this.tokenAt(i)),
                    i
                );
            }
            do c = s.charCodeAt(++i);
            while (isWhitespace(c));
            if (c !== QUOTE && c !== APOSTROPHE) {
                if (i >= s.length) this.endOfStreamInTag();
                this.fail("Unexpected token: " + this.tokenAt(i), i);
            }
            const valueStart = i + 1;
            const close = s.indexOf(c === QUOTE ? '"' : "'", valueStart);
            if (close === -1) this.endOfStreamInTag();
            // most values have nothing to expand or normalize: one scan to
            // know, one slice
            let j = valueStart;
            for (; j < close; j++) {
                const v = s.charCodeAt(j);
                if (v === AMP || v === LT || v === TAB || v === LF) break;
            }
            const value =
                j === close
                    ? s.slice(valueStart, close)
                    : this.attributeValue(valueStart, close, j);
            i = close + 1;
            c = s.charCodeAt(i);
            if (this.isDuplicate(name, count, attrStart)) continue;
            attrNames[count] = name;
            attrValues[count] = value;
            attrStarts[count] = attrStart;
            attrEnds[count] = close;
            count++;
        }

        const scope = count ? this.declarations(count) : this.scope;
        const element = this.element(qname, nameStart, scope, tagEnd);
        if (count) this.attributes(element, scope, count);

        this.flushText();
        appendParsed(this.parent, element);
        this.pos = i;
        if (this.stack.length === 0) this.rootSeen = true;
        if (!selfClosing) {
            this.stack.push(element);
            this.scopes.push(this.scope);
            this.parent = element;
            this.scope = scope;
        }
    }

    // a second attribute of the same name is an error, but Chrome keeps the
    // first of two namespace declarations of the same prefix and goes on
    isDuplicate(name: string, count: number, start: number) {
        for (let k = 0; k < count; k++) {
            if (attrNames[k] !== name) continue;
            if (isNamespaceDeclaration(name)) return true;
            this.fail(`Attribute '${name}' is redefined`, start);
        }
        return false;
    }

    // the scope of a start tag with attributes: the parent's, or a new one
    // when the tag declares namespaces
    declarations(count: number): Scope {
        let scope = this.scope;
        // the errors are reported at the closing quote of the declaration,
        // or just after it, as Chrome does
        for (let k = 0; k < count; k++) {
            const name = attrNames[k];
            if (!isNamespaceDeclaration(name)) continue;
            if (scope === this.scope) {
                scope = {
                    default: scope.default,
                    prefixes: Object.create(scope.prefixes)
                };
            }
            const value = attrValues[k];
            if (name.length === 5) {
                if (value === XMLNS_NS || value === XML_NS) {
                    this.fail(
                        `Namespace '${value}' cannot be default`,
                        attrEnds[k] + (value === XMLNS_NS ? 1 : 0)
                    );
                }
                scope.default = value || null;
                continue;
            }
            const prefix = name.slice(6);
            if (prefix === "xmlns") {
                this.fail("Cannot redefine XMLNS prefix", attrEnds[k]);
            }
            if (prefix === "xml" && value !== XML_NS) {
                this.fail(
                    "Default XMLNS prefix cannot be rebound to another value",
                    attrEnds[k]
                );
            }
            if (value === "") {
                this.fail(`Cannot undefine prefix '${prefix}'`, attrEnds[k]);
            }
            scope.prefixes[prefix] = value;
        }
        return scope;
    }

    element(
        qname: string,
        nameStart: number,
        scope: Scope,
        tagEnd: number
    ): Element {
        const colon = qname.indexOf(":");
        if (colon === -1) {
            return new Element(this.doc, scope.default, qname, null, qname);
        }
        this.checkColons(qname, colon, nameStart, tagEnd);
        const prefix = qname.slice(0, colon);
        if (prefix === "xml" || prefix === "xmlns") {
            this.fail(`'${prefix}' cannot be an element name prefix`, tagEnd);
        }
        const namespace = scope.prefixes[prefix];
        if (namespace === undefined) {
            this.fail(`Element ${qname} prefix is unbound`, tagEnd);
        }
        return new Element(
            this.doc,
            namespace,
            qname,
            prefix,
            qname.slice(colon + 1)
        );
    }

    // a qualified name has one colon at most, with a name on each side (the
    // columns are where Chrome reports them)
    checkColons(qname: string, colon: number, start: number, after: number) {
        if (colon === 0) {
            this.fail("Unexpected token inside qualified name: :", start + 1);
        }
        const second = qname.indexOf(":", colon + 1);
        if (second !== -1) {
            this.fail(
                "Unexpected token inside qualified name: :",
                start + second
            );
        }
        if (colon === qname.length - 1) {
            this.fail("Qualified name is invalid: " + qname, after);
        }
    }

    attributes(element: Element, scope: Scope, count: number) {
        const map: Attr[] = [];
        let namespaced = false;
        for (let k = 0; k < count; k++) {
            const name = attrNames[k];
            const colon = name.indexOf(":");
            let namespace: string | null = null;
            let prefix: string | null = null;
            let localName = name;
            if (isNamespaceDeclaration(name)) {
                namespace = XMLNS_NS;
                if (colon !== -1) {
                    prefix = "xmlns";
                    localName = name.slice(6);
                    // Chrome drops the (allowed, useless) declaration of xml
                    if (localName === "xml") continue;
                }
            } else if (colon !== -1) {
                this.checkColons(
                    name,
                    colon,
                    attrStarts[k],
                    attrStarts[k] + name.length
                );
                prefix = name.slice(0, colon);
                localName = name.slice(colon + 1);
                namespace = scope.prefixes[prefix];
                if (namespace === undefined) {
                    this.fail(
                        `Attribute ${name} prefix is unbound`,
                        attrStarts[k]
                    );
                }
                namespaced = true;
            }
            map.push(
                new Attr(
                    this.doc,
                    namespace,
                    name,
                    prefix,
                    localName,
                    attrValues[k],
                    element
                )
            );
        }
        // two prefixes for one namespace make the same attribute
        if (namespaced) {
            for (let a = 1; a < map.length; a++) {
                const attr = map[a];
                if (attr.prefix === null || attr.prefix === "xmlns") continue;
                for (let b = 0; b < a; b++) {
                    if (
                        map[b].namespaceURI === attr.namespaceURI &&
                        map[b].localName === attr.localName
                    ) {
                        this.fail(
                            `Attribute '{${attr.namespaceURI}}${attr.name}' is redefined`,
                            attrStarts[attrNames.indexOf(attr.name)]
                        );
                    }
                }
            }
        }
        element._attributes = map;
    }

    // an attribute value with references or whitespace to normalize (XML
    // 1.0, 3.3.3: tab and line feed become spaces; the characters of a
    // reference are kept), from `first`, the first such character
    attributeValue(start: number, stop: number, first: number): string {
        const s = this.s;
        let out = "";
        let segment = start;
        for (let i = first; i < stop;) {
            const c = s.charCodeAt(i);
            if (c === TAB || c === LF) {
                out += s.slice(segment, i) + " ";
                segment = ++i;
            } else if (c === AMP) {
                out += s.slice(segment, i) + this.reference(i);
                segment = i = this.refEnd;
            } else if (c === LT) {
                this.fail(`Unexpected token '<' before '${s[i + 1] ?? ""}'`, i);
            } else {
                i++;
            }
        }
        return out + s.slice(segment, stop);
    }

    // </name>
    endTag(lt: number) {
        const s = this.s;
        const depth = this.stack.length;
        if (depth === 0) this.fail("Unexpected token: </", lt);
        const element = this.stack[depth - 1];
        const name = element.tagName;
        let i = lt + 2;
        // the common case: the name of the open element, then ">"
        if (s.startsWith(name, i)) {
            let c = s.charCodeAt(i + name.length);
            if (c === GT) {
                return this.close(i + name.length + 1);
            }
            if (isWhitespace(c)) {
                let j = i + name.length;
                do c = s.charCodeAt(++j);
                while (isWhitespace(c));
                if (c === GT) return this.close(j + 1);
            }
        }
        // anything else is an error: which one
        let c = s.charCodeAt(i);
        if (!isNameStart(c)) {
            if (i >= s.length) this.endOfStreamInTag();
            this.fail("Qualified name is invalid: ", i);
        }
        do c = s.charCodeAt(++i);
        while (isNameChar(c));
        const endName = s.slice(lt + 2, i);
        while (isWhitespace(c)) c = s.charCodeAt(++i);
        if (c !== GT) {
            if (i >= s.length) this.endOfStreamInTag();
            this.fail(
                "Unexpected token inside closing tag: " + this.tokenAt(i),
                i
            );
        }
        const colon = endName.indexOf(":");
        let namespace = this.scope.default;
        if (colon !== -1) {
            namespace = this.scope.prefixes[endName.slice(0, colon)];
            if (namespace === undefined) {
                this.fail(`Element ${endName} prefix is unbound`, i);
            }
        }
        this.fail(
            `Unexpected closing tag: ${expandedName(namespace, endName)} != ${expandedName(element.namespaceURI, name)}`,
            i
        );
    }

    close(after: number) {
        this.flushText();
        this.stack.pop();
        this.scope = this.scopes.pop();
        const depth = this.stack.length;
        this.parent = depth ? this.stack[depth - 1] : this.doc;
        this.pos = after;
    }

    // <!-- -->, <![CDATA[ ]]> and <!DOCTYPE>
    markupDeclaration(lt: number) {
        const s = this.s;
        if (s.startsWith("<!--", lt)) {
            const start = lt + 4;
            const dashes = s.indexOf("--", start);
            if (dashes === -1) this.endOfStream();
            if (s.charCodeAt(dashes + 2) !== GT) {
                if (dashes + 2 >= s.length) this.endOfStream();
                this.fail(
                    `Unexpected token '--' before '${s[dashes + 2]}'`,
                    dashes
                );
            }
            this.flushText();
            appendParsed(
                this.parent,
                new Comment(this.doc, s.slice(start, dashes))
            );
            this.pos = dashes + 3;
            return;
        }
        if (s.startsWith("<![CDATA[", lt)) {
            if (this.stack.length === 0) {
                this.fail("Unexpected token: <![CDATA[", lt);
            }
            const start = lt + 9;
            const end = s.indexOf("]]>", start);
            if (end === -1) this.endOfStream();
            this.flushText();
            appendParsed(
                this.parent,
                new CDATASection(this.doc, s.slice(start, end))
            );
            this.pos = end + 3;
            return;
        }
        if (s.startsWith("<!DOCTYPE", lt)) {
            if (this.rootSeen || this.doctypeSeen) {
                this.fail("Unexpected token: <!DOCTYPE", lt);
            }
            return this.doctype(lt + 9);
        }
        if (lt + 2 >= s.length) this.endOfStream();
        const c = s.charCodeAt(lt + 2);
        const token = c === 0x2d || c === 0x5b ? "<!" + s[lt + 2] : "<!";
        const before = s[lt + token.length];
        if (before === undefined) this.endOfStream();
        this.fail(`Unexpected token '${token}' before '${before}'`, lt);
    }

    // <!DOCTYPE name (SYSTEM "id" | PUBLIC "id" "id")? ([ subset ])? >
    // The internal subset is skipped: its declarations are not applied.
    doctype(i: number) {
        const s = this.s;
        i = this.requireWhitespace(i);
        const nameStart = i;
        if (!isNameStart(s.charCodeAt(i))) this.unexpected(i);
        while (isNameChar(s.charCodeAt(++i)));
        const name = s.slice(nameStart, i);
        i = this.skipWhitespace(i);
        let publicId = "";
        let systemId = "";
        if (s.startsWith("PUBLIC", i)) {
            i = this.requireWhitespace(i + 6);
            publicId = this.quoted(i);
            i = this.requireWhitespace(this.refEnd);
            systemId = this.quoted(i);
            i = this.skipWhitespace(this.refEnd);
        } else if (s.startsWith("SYSTEM", i)) {
            i = this.requireWhitespace(i + 6);
            systemId = this.quoted(i);
            i = this.skipWhitespace(this.refEnd);
        }
        if (s.charCodeAt(i) === 0x5b /* [ */) {
            i = this.skipWhitespace(this.internalSubset(i + 1) + 1);
        }
        if (s.charCodeAt(i) !== GT) this.unexpected(i);
        appendParsed(
            this.parent,
            new DocumentType(this.doc, name, publicId, systemId)
        );
        this.doctypeSeen = true;
        this.pos = i + 1;
    }

    // the index of the "]" that ends the internal subset, skipping the
    // literals, comments and processing instructions that may hold one
    internalSubset(i: number): number {
        const s = this.s;
        for (;;) {
            const c = s.charCodeAt(i);
            let end = i + 1;
            if (c !== c) this.endOfStream(); // NaN: the end of the input
            if (c === 0x5d /* ] */) return i;
            if (c === QUOTE || c === APOSTROPHE) {
                end = s.indexOf(s[i], i + 1) + 1;
            } else if (s.startsWith("<!--", i)) {
                end = s.indexOf("-->", i + 4) + 3;
                if (end === 2) end = 0;
            } else if (s.startsWith("<?", i)) {
                end = s.indexOf("?>", i + 2) + 2;
                if (end === 1) end = 0;
            }
            if (end === 0) this.endOfStream();
            i = end;
        }
    }

    // <?target data?>
    processingInstruction(lt: number) {
        const s = this.s;
        let i = lt + 2;
        let c = s.charCodeAt(i);
        if (!isNameStart(c)) {
            if (i >= s.length) this.endOfStream();
            if (isWhitespace(c) || c === QUESTION) {
                this.fail(
                    "Encountered processing instruction without a name",
                    i
                );
            }
            this.unexpected(i);
        }
        do c = s.charCodeAt(++i);
        while (isNameChar(c));
        const target = s.slice(lt + 2, i);
        if (target.length === 3 && target.toLowerCase() === "xml") {
            this.fail(
                `Invalid processing instruction: <?${target}\nThe XML spec only allows "<?xml" at the very beginning of the file, with no whitespace, comments, or any elements before it`,
                i
            );
        }
        let data = "";
        if (c === QUESTION && s.charCodeAt(i + 1) === GT) {
            i += 2;
        } else {
            if (!isWhitespace(c)) {
                if (i >= s.length) this.endOfStream();
                this.unexpected(i);
            }
            const start = this.skipWhitespace(i);
            const end = s.indexOf("?>", start);
            if (end === -1) this.endOfStream();
            data = s.slice(start, end);
            i = end + 2;
        }
        this.flushText();
        appendParsed(
            this.parent,
            new ProcessingInstruction(this.doc, target, data)
        );
        this.pos = i;
    }

    // <?xml version="1.0" encoding="..." standalone="yes|no"?>, only at the
    // very start of the input
    xmlDeclaration() {
        const s = this.s;
        let i = this.skipWhitespace(5);
        if (!s.startsWith("version", i)) this.unexpected(i);
        const version = this.pseudoAttribute(i + 7);
        if (!/^1\.[0-9]+$/.test(version)) this.unexpected(i + 7);
        let encoding: string | null = null;
        let standalone: boolean | null = null;
        i = this.skipWhitespace(this.refEnd);
        if (s.startsWith("encoding", i) && i > this.refEnd) {
            encoding = this.pseudoAttribute(i + 8);
            i = this.skipWhitespace(this.refEnd);
        }
        if (s.startsWith("standalone", i) && i > this.refEnd) {
            const value = this.pseudoAttribute(i + 10);
            if (value !== "yes" && value !== "no") this.unexpected(i + 10);
            standalone = value === "yes";
            i = this.skipWhitespace(this.refEnd);
        }
        if (!s.startsWith("?>", i)) {
            if (i >= s.length) this.endOfStream();
            this.unexpected(i);
        }
        this.doc._xmlDeclaration = { encoding, standalone };
        this.pos = i + 2;
    }

    // = "value" of the XML declaration; refEnd after the closing quote
    pseudoAttribute(i: number): string {
        i = this.skipWhitespace(i);
        if (this.s.charCodeAt(i) !== EQUALS) this.unexpected(i);
        return this.quoted(this.skipWhitespace(i + 1));
    }

    // a literal in quotes at i; refEnd after the closing quote
    quoted(i: number): string {
        const s = this.s;
        const c = s.charCodeAt(i);
        if (c !== QUOTE && c !== APOSTROPHE) this.unexpected(i);
        const close = s.indexOf(s[i], i + 1);
        if (close === -1) this.endOfStream();
        this.refEnd = close + 1;
        return s.slice(i + 1, close);
    }

    skipWhitespace(i: number) {
        while (isWhitespace(this.s.charCodeAt(i))) i++;
        return i;
    }

    requireWhitespace(i: number) {
        if (!isWhitespace(this.s.charCodeAt(i))) this.unexpected(i);
        return this.skipWhitespace(i);
    }

    unexpected(i: number): never {
        if (i >= this.s.length) this.endOfStream();
        this.fail("Unexpected token: " + this.tokenAt(i), i);
    }
}

function isNamespaceDeclaration(name: string) {
    return (
        name.charCodeAt(0) === 0x78 /* x */ &&
        name.startsWith("xmlns") &&
        (name.length === 5 || name.charCodeAt(5) === 0x3a)
    );
}

// "&#...;" without "&#" and ";": the code point, or -1 when malformed
function parseCharacterReference(body: string): number {
    const hex = body.charCodeAt(0) === 0x78; /* x */
    let code = 0;
    let i = hex ? 1 : 0;
    if (i === body.length) return -1;
    for (; i < body.length; i++) {
        const c = body.charCodeAt(i);
        let digit: number;
        if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
        else if (hex && c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10;
        else if (hex && c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10;
        else return -1;
        // past the last code point, the value only needs to stay invalid
        code = Math.min(code * (hex ? 16 : 10) + digit, 0x110000);
    }
    return code;
}

function codePointName(code: number) {
    return "U+" + code.toString(16).toUpperCase().padStart(4, "0");
}

// Chrome prints a character of its messages as the Latin-1 reading of its
// UTF-8 bytes (U+FEFF is "ï»¿")
function latin1OfUtf8(code: number) {
    const bytes = new TextEncoder().encode(String.fromCodePoint(code));
    return String.fromCharCode(...bytes);
}

function expandedName(namespace: string | null, qname: string) {
    return namespace ? `{${namespace}}${qname}` : qname;
}

// 1-based line and column (in code points) of index
function position(input: string, index: number) {
    let line = 1;
    let lineStart = 0;
    for (
        let nl = input.indexOf("\n");
        nl !== -1 && nl < index;
        nl = input.indexOf("\n", nl + 1)
    ) {
        line++;
        lineStart = nl + 1;
    }
    let column = 1;
    for (let i = lineStart; i < index; i++) {
        const c = input.charCodeAt(i);
        // the second half of a surrogate pair is the same character
        if (c < 0xdc00 || c > 0xdfff || i === lineStart) column++;
    }
    return { line, column };
}

function insertParserError(doc: XMLDocument, input: string, error: ParseError) {
    const { line, column } = position(input, error.index);
    const xhtml = (name: string, text?: string) => {
        const element = doc.createElementNS(XHTML_NS, name);
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const parsererror = xhtml("parsererror");
    parsererror.setAttribute("style", PARSERERROR_STYLE);
    const message = xhtml(
        "div",
        `error on line ${line} at column ${column}: ${error.message}`
    );
    message.setAttribute("style", "font-family:monospace;font-size:12px");
    parsererror.append(
        xhtml("h3", "This page contains the following errors:"),
        message,
        xhtml("h3", "Below is a rendering of the page up to the first error.")
    );
    const root = doc.documentElement;
    if (root) {
        root.insertBefore(parsererror, root.firstChild);
    } else {
        const html = xhtml("html");
        const body = xhtml("body");
        body.appendChild(parsererror);
        html.appendChild(body);
        doc.appendChild(html);
    }
}

// ---------------------------------------------------------------------------
// HTML ("text/html")
//
// A lenient parser at the level of xmldom's HTML mode, which served
// DOMParser in workers before Stage 6: any input gives a document, never a
// parsererror. It follows the tokenizer of the HTML standard and the parts
// of its tree construction that decide which element a node goes in:
// - names of elements and attributes are lowercased, the elements are in
//   the XHTML namespace (tagName uppercase, as in the browser);
// - void elements (br, img, input, meta...) take no content and need no
//   "/>"; on any other HTML element "/>" is ignored, as the browser does;
// - an element is closed where HTML closes it implicitly: an open <p> by
//   the start of a block (div, ul, table, h1...), <li>, <dt>/<dd>,
//   <option>, <tr>, <td>/<th> and <tbody>/<thead>/<tfoot> by a sibling of
//   the same kind, a heading by another heading, <a> by another <a>, and
//   everything by the end of the input;
// - an end tag closes the nearest open element of its name, and those
//   above it, unless an element that bounds it comes first (an end tag of
//   an inline element does not close a <div>, nothing closes past a
//   <table> or a cell); an end tag with nothing to close is ignored, but
//   for the browser's </br> (a <br>) and </p> (an empty <p>);
// - script, style, xmp, iframe, noembed and noframes hold raw text up to
//   their end tag, textarea and title text with character references,
//   plaintext the rest of the input;
// - the named character references of entities.ts (with the legacy forms
//   without semicolon), numeric references with the browser's
//   replacements; an unknown reference stays as text;
// - attributes without a value (disabled="") or with an unquoted one, the
//   first of two of the same name;
// - comments, bogus comments (<!x>, <?x?>, </ x>) as comments, the DOCTYPE
//   as a DocumentType;
// - <svg> and <math> put their content in the SVG and MathML namespaces,
//   with the case of the markup kept (viewBox), "/>" closing, CDATA
//   sections as text and xlink:, xml: and xmlns attributes in their
//   namespaces, back to HTML inside foreignObject, desc and title.
//
// Then the implied <html>, <head> and <body> (implyStructure, after the
// parse): what the markup does not have is created, the head elements
// (title, meta, link, script, style...) that come before the content go
// into <head>, the rest into <body>, and the whitespace before the content
// is dropped, as in the browser; the DOCTYPE and the comments before the
// content stay on the document.
//
// Not done: the implied <tbody>, and an element of the head after the
// content stays where it is (the browser keeps it there too, but moves a
// <title> or <meta> written between <head> and <body>). Nor are the
// browser's repairs: text misplaced in a table stays where it is, a
// <td> outside a table is an element, misnested formatting (<b><i></b></i>)
// is not reconstructed, an HTML element in SVG does not end the SVG, SVG
// names are not case-corrected (<svg><Foo> stays Foo where the browser
// makes it foo), and quirks mode, where a <table> stays in an open <p>, is
// taken as the absence of <!DOCTYPE html>.

// What the tree construction needs to know of an HTML element, as bits
const VOID = 1; // no content and no end tag
const SPECIAL = 2; // the "special" category: bounds the end tags of others
const SCOPE = 4; // bounds the default scope (the search for an end tag)
const TABLE_SCOPE = 8; // bounds the table scope
const LIST_SCOPE = 16; // bounds the list item scope, with SCOPE
const BUTTON_SCOPE = 32; // bounds the button scope, with SCOPE
const LIST_PASS = 64; // special, but a <li> start tag looks past it
const TABLE_PART = 128; // its end tag is searched in table scope
const ROW = 256; // tr: bounds the search for an open cell
const SECTION = 512; // tbody, thead, tfoot: bound the search for a row
const CLOSES_P = 1024; // its start tag closes an open <p>
const RAW_TEXT = 2048; // its content is text up to its end tag
const ESCAPABLE_RAW_TEXT = 4096; // the same, with character references

const HTML_KINDS: Record<string, number> = Object.create(null);
function kinds(flags: number, names: string) {
    for (const name of names.split(" ")) {
        HTML_KINDS[name] = (HTML_KINDS[name] ?? 0) | flags;
    }
}
kinds(
    SPECIAL,
    "address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp"
);
// the void elements of HTML and the obsolete ones the browser (and xmldom
// for param) also parses as void
kinds(
    VOID,
    "area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr"
);
kinds(SCOPE, "applet caption html table td th marquee object template");
kinds(TABLE_SCOPE, "html table template");
kinds(LIST_SCOPE, "ol ul");
kinds(BUTTON_SCOPE, "button");
kinds(LIST_PASS, "address div p");
kinds(TABLE_PART, "caption colgroup table tbody td tfoot th thead tr");
kinds(ROW, "tr");
kinds(SECTION, "tbody thead tfoot");
kinds(
    CLOSES_P,
    "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li dd dt listing main menu nav ol p plaintext pre search section summary table ul xmp"
);
// noscript is not here: DOMParser's documents run no script, so the
// browser parses its content as markup
kinds(RAW_TEXT, "script style xmp iframe noembed noframes");
kinds(ESCAPABLE_RAW_TEXT, "textarea title");

const HEADING = /^h[1-6]$/;
const TD_TH = ["td", "th"];
const DD_DT = ["dd", "dt"];
const SECTIONS = ["tbody", "thead", "tfoot"];

// the attributes of SVG and MathML elements that have a namespace:
// [namespace, prefix, localName]
const FOREIGN_ATTRIBUTES: Record<string, [string, string | null, string]> =
    Object.assign(Object.create(null), {
        "xlink:actuate": [XLINK_NS, "xlink", "actuate"],
        "xlink:arcrole": [XLINK_NS, "xlink", "arcrole"],
        "xlink:href": [XLINK_NS, "xlink", "href"],
        "xlink:role": [XLINK_NS, "xlink", "role"],
        "xlink:show": [XLINK_NS, "xlink", "show"],
        "xlink:title": [XLINK_NS, "xlink", "title"],
        "xlink:type": [XLINK_NS, "xlink", "type"],
        "xml:lang": [XML_NS, "xml", "lang"],
        "xml:space": [XML_NS, "xml", "space"],
        xmlns: [XMLNS_NS, null, "xmlns"],
        "xmlns:xlink": [XMLNS_NS, "xmlns", "xlink"]
    });

// what a numeric reference to 0x80-0x9F gives: the windows-1252 character
// (&#x80; is the euro sign), as in the browser
const WINDOWS_1252: Record<number, number> = {
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x0192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x02c6,
    0x89: 0x2030,
    0x8a: 0x0160,
    0x8b: 0x2039,
    0x8c: 0x0152,
    0x8e: 0x017d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x02dc,
    0x99: 0x2122,
    0x9a: 0x0161,
    0x9b: 0x203a,
    0x9c: 0x0153,
    0x9e: 0x017e,
    0x9f: 0x0178
};

const DOCTYPE =
    /^\s*([^\s>]*)(?:\s+PUBLIC\s*("[^"]*"|'[^']*')(?:\s*("[^"]*"|'[^']*'))?|\s+SYSTEM\s*("[^"]*"|'[^']*'))?/i;

// HTML whitespace (carriage returns are normalized away first)
function isSpace(c: number) {
    return c === SPACE || c === LF || c === TAB || c === 0x0c;
}

function isAsciiAlpha(c: number) {
    return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isAsciiAlphanumeric(c: number) {
    return isAsciiAlpha(c) || (c >= 0x30 && c <= 0x39);
}

// the end of a tag name; NaN (the end of the input) too
function isTagNameEnd(c: number) {
    return isSpace(c) || c === SLASH || c === GT || c !== c;
}

function isIntegrationPoint(element: Element) {
    const name = element.localName;
    if (element.namespaceURI === SVG_NS) {
        // the markup's case is kept in SVG: <foreignobject> is one too
        const lower = asciiLower(name);
        return (
            lower === "foreignobject" || lower === "desc" || lower === "title"
        );
    }
    return (
        element.namespaceURI === MATHML_NS &&
        (name === "mi" ||
            name === "mo" ||
            name === "mn" ||
            name === "ms" ||
            name === "mtext" ||
            name === "annotation-xml")
    );
}

// the bits of an open element; an SVG or MathML element where HTML comes
// back counts as special and bounds the scopes
function kindOf(element: Element): number {
    if (element.namespaceURI === XHTML_NS) {
        return HTML_KINDS[element.localName] ?? 0;
    }
    return isIntegrationPoint(element) ? SPECIAL | SCOPE : 0;
}

// the code point of a numeric reference, with the browser's replacements
function referencedCharacter(code: number) {
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return 0xfffd;
    }
    return WINDOWS_1252[code] ?? code;
}

function unquote(literal: string | undefined) {
    return literal === undefined ? "" : literal.slice(1, -1);
}

// fragment: the top-level nodes of the markup on the document, without the
// implied elements (innerHTML, html.ts parseFragment)
export function parseHTML(input: string, fragment = false): HTMLDocument {
    if (input.indexOf("\r") !== -1) input = input.replace(/\r\n?/g, "\n");
    if (typeof input.isWellFormed === "function" && !input.isWellFormed()) {
        input = input.toWellFormed();
    }
    const doc = new HTMLDocument();
    new HTMLParser(input, doc).run();
    if (!fragment) implyStructure(doc);
    return doc;
}

// the elements that go into an implied <head> when they come first
const HEAD_ELEMENTS = new Set([
    "base",
    "basefont",
    "bgsound",
    "link",
    "meta",
    "noscript",
    "script",
    "style",
    "template",
    "title"
]);

function isHTMLElement(node: Node | null, names: Set<string> | string) {
    return (
        node instanceof Element &&
        node.namespaceURI === XHTML_NS &&
        (typeof names === "string"
            ? node.localName === names
            : names.has(node.localName))
    );
}

function isBlankText(node: Node) {
    return (
        node.constructor === Text && /^[\t\n\f ]*$/.test((node as Text).data)
    );
}

// <html> with <head> and <body>, for the markup that lacks them
function implyStructure(doc: HTMLDocument) {
    let html = doc.documentElement;
    if (!isHTMLElement(html, "html")) {
        html = doc.createElement("html");
        const top = [...doc.childNodes];
        let i = 0;
        for (; i < top.length; i++) {
            const node = top[i];
            if (node instanceof DocumentType || node instanceof Comment) {
                continue;
            }
            if (!isBlankText(node)) break;
            doc.removeChild(node);
        }
        for (; i < top.length; i++) {
            // a DOCTYPE after the content stays on the document
            if (!(top[i] instanceof DocumentType)) html.appendChild(top[i]);
        }
        doc.appendChild(html);
    }
    let head: Element | null = null;
    let body: Element | null = null;
    for (const child of html.childNodes) {
        if (isHTMLElement(child, "head")) head ??= child as Element;
        else if (isHTMLElement(child, "body")) body ??= child as Element;
    }
    if (head === null) {
        head = doc.createElement("head");
        const lead: Node[] = [];
        for (let n = html.firstChild; n !== null; n = n.nextSibling) {
            if (isHTMLElement(n, HEAD_ELEMENTS) || isBlankText(n)) {
                lead.push(n);
            } else break;
        }
        html.insertBefore(head, html.firstChild);
        if (lead.some((n) => n instanceof Element)) {
            for (const node of lead) head.appendChild(node);
        }
    }
    if (body === null) {
        body = doc.createElement("body");
        const rest: Node[] = [];
        for (let n = head.nextSibling; n !== null; n = n.nextSibling) {
            rest.push(n);
        }
        html.appendChild(body);
        for (const node of rest) body.appendChild(node);
    }
}

class HTMLParser {
    s: string;
    doc: HTMLDocument;
    // the open elements; parent is where the next node goes (the document
    // when none is open)
    stack: Element[] = [];
    parent: Node;
    // quirks mode, where a <table> stays inside an open <p>: the browser's
    // rule approximated as no DOCTYPE, or one not named html
    quirks = true;
    // the next "&" at or after the text being read (see Parser.nextAmp)
    nextAmp = -1;
    // end of the last reference read by reference()
    refEnd = 0;

    constructor(input: string, doc: HTMLDocument) {
        this.s = input;
        this.doc = doc;
        this.parent = doc;
    }

    run() {
        const s = this.s;
        let textStart = 0;
        let i = 0;
        for (;;) {
            const lt = s.indexOf("<", i);
            if (lt === -1) break;
            const c = s.charCodeAt(lt + 1);
            let next: number;
            if (isAsciiAlpha(c)) {
                this.text(textStart, lt);
                next = this.startTag(lt);
            } else if (c === SLASH) {
                const d = s.charCodeAt(lt + 2);
                if (d !== d) {
                    // "</" at the end of the input is text
                    i = lt + 1;
                    continue;
                }
                this.text(textStart, lt);
                if (isAsciiAlpha(d)) next = this.endTag(lt);
                else if (d === GT)
                    next = lt + 3; // "</>" is dropped
                else next = this.bogusComment(lt + 2);
            } else if (c === BANG) {
                this.text(textStart, lt);
                next = this.markupDeclaration(lt);
            } else if (c === QUESTION) {
                this.text(textStart, lt);
                next = this.bogusComment(lt + 1);
            } else {
                // a "<" that starts no markup ("a < b") is text
                i = lt + 1;
                continue;
            }
            i = textStart = next;
        }
        this.text(textStart, s.length);
    }

    push(element: Element) {
        this.stack.push(element);
        this.parent = element;
    }

    // closes the open elements from index k up
    truncate(k: number) {
        this.stack.length = k;
        this.parent = k ? this.stack[k - 1] : this.doc;
    }

    current(): Element | null {
        const stack = this.stack;
        return stack.length ? stack[stack.length - 1] : null;
    }

    // closes the current element if it is the HTML element `name`
    popIf(name: string) {
        const current = this.current();
        if (
            current !== null &&
            current.localName === name &&
            current.namespaceURI === XHTML_NS
        ) {
            this.truncate(this.stack.length - 1);
        }
    }

    // Closes the nearest open HTML element named one of `names` and those
    // above it, unless an element with one of the `bounds` bits (and none of
    // the `pass` bits) comes first. Returns whether it closed one.
    closeNearest(names: readonly string[], bounds: number, pass = 0) {
        const stack = this.stack;
        for (let k = stack.length - 1; k >= 0; k--) {
            const element = stack[k];
            if (
                element.namespaceURI === XHTML_NS &&
                names.includes(element.localName)
            ) {
                this.truncate(k);
                return true;
            }
            const kind = kindOf(element);
            if (kind & bounds && !(kind & pass)) return false;
        }
        return false;
    }

    // the text from start to stop, its references expanded
    text(start: number, stop: number) {
        if (stop > start) this.appendText(this.decode(start, stop, false));
    }

    // text goes into the Text node it follows, as in the browser: what is
    // dropped between two runs ("a</span>b") leaves one node
    appendText(data: string) {
        const children = this.parent._children;
        const last =
            children !== null && children.length
                ? children[children.length - 1]
                : null;
        if (last !== null && last.constructor === Text) {
            (last as Text).data += data;
        } else {
            appendParsed(this.parent, new Text(this.doc, data));
        }
    }

    // the text of s from start to stop with its character references
    // expanded; in an attribute value, the legacy ones without semicolon
    // are only expanded when not followed by "=" or a letter or digit
    // ("?a=1&copy=2" stays)
    decode(start: number, stop: number, attribute: boolean): string {
        const s = this.s;
        if (this.nextAmp < start) {
            const amp = s.indexOf("&", start);
            this.nextAmp = amp === -1 ? Infinity : amp;
        }
        if (this.nextAmp >= stop) return s.slice(start, stop);
        let out = "";
        let segment = start;
        let amp = this.nextAmp;
        while (amp < stop) {
            const value = this.reference(amp, stop, attribute);
            let from = amp + 1;
            if (value !== null) {
                out += s.slice(segment, amp) + value;
                segment = from = this.refEnd;
            }
            const next = s.indexOf("&", from);
            amp = next === -1 ? Infinity : next;
        }
        this.nextAmp = amp;
        return out + s.slice(segment, stop);
    }

    // the character reference at amp: its text (refEnd after it), or null
    // when it is not one and stays as written
    reference(amp: number, stop: number, attribute: boolean): string | null {
        const s = this.s;
        let i = amp + 1;
        if (s.charCodeAt(i) === HASH) {
            i++;
            const hex = (s.charCodeAt(i) | 0x20) === 0x78; /* x or X */
            if (hex) i++;
            const start = i;
            let code = 0;
            for (; i < stop; i++) {
                const c = s.charCodeAt(i);
                let digit: number;
                if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
                else if (hex && (c | 0x20) >= 0x61 && (c | 0x20) <= 0x66) {
                    digit = (c | 0x20) - 0x61 + 10;
                } else break;
                // past the last code point, the value only needs to stay
                // invalid
                code = Math.min(code * (hex ? 16 : 10) + digit, 0x110000);
            }
            if (i === start) return null;
            if (i < stop && s.charCodeAt(i) === SEMICOLON) i++;
            this.refEnd = i;
            return String.fromCodePoint(referencedCharacter(code));
        }
        const start = i;
        while (i < stop && isAsciiAlphanumeric(s.charCodeAt(i))) i++;
        if (i === start) return null;
        const name = s.slice(start, i);
        if (i < stop && s.charCodeAt(i) === SEMICOLON) {
            const value = HTML_ENTITIES[name];
            if (value !== undefined) {
                this.refEnd = i + 1;
                return value;
            }
        }
        if (attribute) {
            if (!LEGACY_ENTITIES.has(name) || s.charCodeAt(i) === EQUALS) {
                return null;
            }
            this.refEnd = i;
            return HTML_ENTITIES[name];
        }
        // in text, the longest legacy name the characters start with:
        // "&copy2026" is "©2026", "&notit;" is "¬it;"
        for (let n = Math.min(name.length, 6); n >= 2; n--) {
            const prefix = name.slice(0, n);
            if (LEGACY_ENTITIES.has(prefix)) {
                this.refEnd = start + n;
                return HTML_ENTITIES[prefix];
            }
        }
        return null;
    }

    // <name attr=value ...>: the position after it (and after the content
    // of a raw text element)
    startTag(lt: number): number {
        const s = this.s;
        let i = lt + 1;
        let c: number;
        do c = s.charCodeAt(++i);
        while (!isTagNameEnd(c));
        const rawName = s.slice(lt + 1, i);
        const names: string[] = [];
        const values: string[] = [];
        let selfClosing = false;
        for (;;) {
            // a "/" not followed by ">" is ignored
            while (isSpace(c) || (c === SLASH && s.charCodeAt(i + 1) !== GT)) {
                c = s.charCodeAt(++i);
            }
            // the end of the input inside a tag drops the tag
            if (c !== c) return s.length;
            if (c === GT) {
                i++;
                break;
            }
            if (c === SLASH) {
                selfClosing = true;
                i += 2;
                break;
            }
            // the name: its first character can be "=" or a quote
            const nameStart = i;
            do c = s.charCodeAt(++i);
            while (
                !isSpace(c) &&
                c !== SLASH &&
                c !== GT &&
                c !== EQUALS &&
                c === c
            );
            const name = s.slice(nameStart, i);
            while (isSpace(c)) c = s.charCodeAt(++i);
            let value = "";
            if (c === EQUALS) {
                do c = s.charCodeAt(++i);
                while (isSpace(c));
                if (c === QUOTE || c === APOSTROPHE) {
                    const close = s.indexOf(c === QUOTE ? '"' : "'", i + 1);
                    if (close === -1) return s.length;
                    value = this.decode(i + 1, close, true);
                    i = close + 1;
                } else {
                    const start = i;
                    while (!isSpace(c) && c !== GT && c === c) {
                        c = s.charCodeAt(++i);
                    }
                    value = this.decode(start, i, true);
                }
                c = s.charCodeAt(i);
            }
            names.push(name);
            values.push(value);
        }
        return this.element(rawName, names, values, selfClosing, i);
    }

    // the element of a start tag, put where HTML puts it; `after` is the
    // position after the tag
    element(
        rawName: string,
        names: string[],
        values: string[],
        selfClosing: boolean,
        after: number
    ): number {
        const doc = this.doc;
        const name = asciiLower(rawName);
        const current = this.current();
        let namespace = XHTML_NS;
        if (
            current !== null &&
            current.namespaceURI !== XHTML_NS &&
            !isIntegrationPoint(current)
        ) {
            namespace = current.namespaceURI;
        } else if (name === "svg") {
            namespace = SVG_NS;
        } else if (name === "math") {
            namespace = MATHML_NS;
        }

        if (namespace !== XHTML_NS) {
            // <svg> and <math> are lowercase, their content keeps the case
            // of the markup
            const localName =
                current?.namespaceURI === namespace ? rawName : name;
            const element = new Element(
                doc,
                namespace,
                localName,
                null,
                localName
            );
            if (names.length) this.attributes(element, names, values, true);
            appendParsed(this.parent, element);
            if (!selfClosing) this.push(element);
            return after;
        }

        this.closeImplied(name);
        const element = new Element(
            doc,
            XHTML_NS,
            asciiUpper(name),
            null,
            name
        );
        if (names.length) this.attributes(element, names, values, false);
        appendParsed(this.parent, element);
        const kind = HTML_KINDS[name] ?? 0;
        if (kind & VOID) return after;
        this.push(element);
        // a newline right after these start tags is not content
        if (
            (name === "pre" || name === "listing" || name === "textarea") &&
            this.s.charCodeAt(after) === LF
        ) {
            after++;
        }
        if (kind & (RAW_TEXT | ESCAPABLE_RAW_TEXT)) {
            return this.rawText(name, after, (kind & ESCAPABLE_RAW_TEXT) !== 0);
        }
        if (name === "plaintext") {
            if (after < this.s.length) this.appendText(this.s.slice(after));
            return this.s.length;
        }
        return after;
    }

    // the open elements a start tag of `name` closes
    closeImplied(name: string) {
        const kind = HTML_KINDS[name] ?? 0;
        if (name === "li") this.closeNearest(["li"], SPECIAL, LIST_PASS);
        else if (name === "dd" || name === "dt") {
            this.closeNearest(DD_DT, SPECIAL, LIST_PASS);
        }
        if (kind & CLOSES_P && !(name === "table" && this.quirks)) {
            this.closeNearest(["p"], SCOPE | BUTTON_SCOPE);
        }
        const current = this.current();
        const currentName =
            current !== null && current.namespaceURI === XHTML_NS
                ? current.localName
                : "";
        if (HEADING.test(name) && HEADING.test(currentName)) {
            this.truncate(this.stack.length - 1);
        }
        switch (name) {
            case "option":
                this.popIf("option");
                break;
            case "optgroup":
                this.popIf("option");
                this.popIf("optgroup");
                break;
            case "button":
                this.closeNearest(["button"], SCOPE);
                break;
            // the browser's adoption agency, simplified: a link does not
            // nest in a link
            case "a":
                this.closeNearest(["a"], SPECIAL);
                break;
            case "td":
            case "th":
                this.closeNearest(TD_TH, TABLE_SCOPE | SECTION | ROW);
                break;
            case "tr":
                this.closeNearest(["tr"], TABLE_SCOPE | SECTION);
                break;
            case "tbody":
            case "thead":
            case "tfoot":
                this.closeNearest(SECTIONS, TABLE_SCOPE);
                break;
        }
    }

    // the attributes of a start tag: lowercase on an HTML element, as
    // written on an SVG or MathML one; the first of two of a name is kept
    attributes(
        element: Element,
        names: string[],
        values: string[],
        foreign: boolean
    ) {
        const doc = this.doc;
        const list: Attr[] = [];
        next: for (let k = 0; k < names.length; k++) {
            const name = foreign ? names[k] : asciiLower(names[k]);
            for (let j = 0; j < list.length; j++) {
                if (list[j].name === name) continue next;
            }
            const adjusted = foreign ? FOREIGN_ATTRIBUTES[name] : undefined;
            list.push(
                adjusted === undefined
                    ? new Attr(doc, null, name, null, name, values[k], element)
                    : new Attr(
                          doc,
                          adjusted[0],
                          name,
                          adjusted[1],
                          adjusted[2],
                          values[k],
                          element
                      )
            );
        }
        element._attributes = list;
    }

    // the content of a raw text element (the current element), up to its
    // end tag in any case, which closes it; with no end tag, the rest of
    // the input
    rawText(name: string, start: number, escapable: boolean): number {
        const s = this.s;
        let end = start;
        for (;;) {
            end = s.indexOf("</", end);
            if (end === -1) {
                end = s.length;
                break;
            }
            const after = end + 2 + name.length;
            const c = s.charCodeAt(after);
            if (
                c === c &&
                isTagNameEnd(c) &&
                asciiLower(s.slice(end + 2, after)) === name
            ) {
                break;
            }
            end += 2;
        }
        if (end > start) {
            this.appendText(
                escapable ? this.decode(start, end, false) : s.slice(start, end)
            );
        }
        if (end === s.length) return end;
        this.truncate(this.stack.length - 1);
        const gt = s.indexOf(">", end);
        return gt === -1 ? s.length : gt + 1;
    }

    // </name>: closes the nearest open element of that name (in any
    // namespace) and those above it, unless an element that bounds its
    // search comes first; ignored when there is none
    endTag(lt: number): number {
        const s = this.s;
        let i = lt + 2;
        while (!isTagNameEnd(s.charCodeAt(i))) i++;
        const name = asciiLower(s.slice(lt + 2, i));
        // the rest of the tag (attributes on an end tag) is ignored
        const gt = s.indexOf(">", i);
        if (gt === -1) return s.length;
        const kind = HTML_KINDS[name] ?? 0;
        const bounds =
            name === "p"
                ? SCOPE | BUTTON_SCOPE
                : name === "li"
                  ? SCOPE | LIST_SCOPE
                  : kind & TABLE_PART
                    ? TABLE_SCOPE
                    : kind & SPECIAL
                      ? SCOPE
                      : SPECIAL;
        const stack = this.stack;
        for (let k = stack.length - 1; k >= 0; k--) {
            const element = stack[k];
            const elementName =
                element.namespaceURI === XHTML_NS
                    ? element.localName
                    : asciiLower(element.localName);
            if (elementName === name) {
                this.truncate(k);
                return gt + 1;
            }
            if (kindOf(element) & bounds) break;
        }
        // nothing to close: the browser's two exceptions to ignoring the
        // tag, in HTML content: </br> is a <br>, and a </p> an empty <p>
        const current = this.current();
        if (
            (name === "br" || name === "p") &&
            (current === null ||
                current.namespaceURI === XHTML_NS ||
                isIntegrationPoint(current))
        ) {
            this.element(name, [], [], false, gt + 1);
            if (name === "p") this.truncate(this.stack.length - 1);
        }
        return gt + 1;
    }

    // <!-- -->, <!DOCTYPE>, <![CDATA[ ]]> in SVG or MathML, or a bogus
    // comment
    markupDeclaration(lt: number): number {
        const s = this.s;
        if (s.startsWith("<!--", lt)) {
            let start = lt + 4;
            // <!--> and <!---> are empty comments
            if (s.charCodeAt(start) === GT)
                return this.comment(start, start, 1);
            if (s.startsWith("->", start)) return this.comment(start, start, 2);
            const end = s.indexOf("-->", start);
            return end === -1
                ? this.comment(start, s.length, 0)
                : this.comment(start, end, 3);
        }
        if (asciiLower(s.slice(lt + 2, lt + 9)) === "doctype") {
            return this.doctype(lt + 9);
        }
        const current = this.current();
        if (
            s.startsWith("<![CDATA[", lt) &&
            current !== null &&
            current.namespaceURI !== XHTML_NS
        ) {
            const start = lt + 9;
            const end = s.indexOf("]]>", start);
            const stop = end === -1 ? s.length : end;
            if (stop > start) this.appendText(s.slice(start, stop));
            return end === -1 ? s.length : end + 3;
        }
        return this.bogusComment(lt + 2);
    }

    // a comment of s from start to stop, followed by `skip` characters
    comment(start: number, stop: number, skip: number): number {
        appendParsed(
            this.parent,
            new Comment(this.doc, this.s.slice(start, stop))
        );
        return stop + skip;
    }

    // <!x>, <?x?>, </ x>: a comment of what is up to the next ">"
    bogusComment(start: number): number {
        const gt = this.s.indexOf(">", start);
        return gt === -1
            ? this.comment(start, this.s.length, 0)
            : this.comment(start, gt, 1);
    }

    // <!DOCTYPE name PUBLIC "id" "id">, from after "<!DOCTYPE"; kept before
    // the first element only, as the browser does
    doctype(i: number): number {
        const s = this.s;
        const gt = s.indexOf(">", i);
        const end = gt === -1 ? s.length : gt;
        const doc = this.doc;
        if (
            this.stack.length === 0 &&
            doc.documentElement === null &&
            doc.doctype === null
        ) {
            const match = DOCTYPE.exec(s.slice(i, end));
            const name = asciiLower(match[1]);
            appendParsed(
                doc,
                new DocumentType(
                    doc,
                    name,
                    unquote(match[2]),
                    unquote(match[3] ?? match[4])
                )
            );
            this.quirks = name !== "html";
        }
        return gt === -1 ? s.length : gt + 1;
    }
}
