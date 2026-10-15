// innerHTML and outerHTML of dom.ts: the HTML fragment serialization of
// the HTML standard (what the browser gives for an element of an HTML
// document) and the fragment parsing of their setters. In an XML document
// both are XML: XMLSerializer's output, and the markup parsed as the
// content of the element (a SyntaxError when it is not well-formed).

import {
    Attr,
    Comment,
    DocumentType,
    Element,
    HTMLDocument,
    MATHML_NS,
    type Node,
    ProcessingInstruction,
    SVG_NS,
    Text,
    XHTML_NS,
    XLINK_NS,
    XML_NS,
    XMLNS_NS,
    fragments
} from "./dom.ts";
import { parseHTML, parseXML } from "./parse.ts";
import { XMLSerializer } from "./serialize.ts";

const VOID_ELEMENTS = new Set([
    "area",
    "base",
    "basefont",
    "bgsound",
    "br",
    "col",
    "embed",
    "frame",
    "hr",
    "img",
    "input",
    "keygen",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr"
]);

// the elements whose text is written as is (noscript is not: DOMParser's
// documents run no script)
const RAW_TEXT_ELEMENTS = new Set([
    "style",
    "script",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "plaintext"
]);

// the elements whose content the fragment parser reads as text
const TEXT_CONTEXTS = new Set([...RAW_TEXT_ELEMENTS, "textarea", "title"]);

function isHTML(node: Node | null): node is Element {
    return node instanceof Element && node.namespaceURI === XHTML_NS;
}

export function serializeHTML(element: Element, childrenOnly: boolean) {
    if (!(element.ownerDocument instanceof HTMLDocument)) {
        const serializer = new XMLSerializer();
        return childrenOnly
            ? element.childNodes
                  .map((child) => serializer.serializeToString(child))
                  .join("")
            : serializer.serializeToString(element);
    }
    return childrenOnly ? children(element) : node(element, null);
}

function children(parent: Node) {
    let out = "";
    for (const child of parent.childNodes) out += node(child, parent);
    return out;
}

function node(current: Node, parent: Node | null): string {
    if (current instanceof Element) {
        const ns = current.namespaceURI;
        const name =
            ns === XHTML_NS || ns === SVG_NS || ns === MATHML_NS
                ? current.localName
                : current.tagName;
        let out = "<" + name;
        for (const attr of current.attributes) {
            out += ` ${attributeName(attr)}="${escape(attr.value, true)}"`;
        }
        out += ">";
        if (isHTML(current) && VOID_ELEMENTS.has(current.localName)) {
            return out;
        }
        return out + children(current) + `</${name}>`;
    }
    if (current instanceof Text) {
        return isHTML(parent) && RAW_TEXT_ELEMENTS.has(parent.localName)
            ? current.data
            : escape(current.data, false);
    }
    if (current instanceof Comment) return `<!--${current.data}-->`;
    if (current instanceof ProcessingInstruction) {
        return `<?${current.target} ${current.data}>`;
    }
    if (current instanceof DocumentType) return `<!DOCTYPE ${current.name}>`;
    return children(current);
}

function attributeName(attr: Attr) {
    switch (attr.namespaceURI) {
        case null:
            return attr.localName;
        case XML_NS:
            return "xml:" + attr.localName;
        case XMLNS_NS:
            return attr.localName === "xmlns"
                ? "xmlns"
                : "xmlns:" + attr.localName;
        case XLINK_NS:
            return "xlink:" + attr.localName;
        default:
            return attr.name;
    }
}

// & and no-break space everywhere, < and > (and " in an attribute value)
function escape(text: string, attribute: boolean) {
    return text.replace(attribute ? /[& "<>]/g : /[& <>]/g, (c) =>
        c === "&"
            ? "&amp;"
            : c === " "
              ? "&nbsp;"
              : c === '"'
                ? "&quot;"
                : c === "<"
                  ? "&lt;"
                  : "&gt;"
    );
}

// the markup as nodes of context's document, in a fragment
export function parseFragment(context: Element, markup: string) {
    const owner = context.ownerDocument;
    const fragment = owner.createDocumentFragment();
    markup = String(markup);
    if (owner instanceof HTMLDocument) {
        if (isHTML(context) && TEXT_CONTEXTS.has(context.localName)) {
            if (markup) fragment.appendChild(owner.createTextNode(markup));
            return fragment;
        }
        const parsed = parseHTML(markup, true);
        for (const child of [...parsed.childNodes]) {
            if (!(child instanceof DocumentType)) {
                fragment.appendChild(owner.adoptNode(child));
            }
        }
        return fragment;
    }
    const ns = context.namespaceURI;
    const parsed = parseXML(
        `<fragment${ns ? ` xmlns="${escape(ns, true)}"` : ""}>${markup}</fragment>`,
        "application/xml"
    );
    const root = parsed.documentElement;
    if (
        root?.localName !== "fragment" ||
        parsed.getElementsByTagName("parsererror").length > 0
    ) {
        throw new DOMException(
            "Failed to set the 'innerHTML' property on 'Element': The provided markup is invalid XML, and therefore cannot be inserted into an XML document.",
            "SyntaxError"
        );
    }
    for (const child of [...root.childNodes]) {
        fragment.appendChild(owner.adoptNode(child));
    }
    return fragment;
}

fragments.serialize = serializeHTML;
fragments.parse = parseFragment;
