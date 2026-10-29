// XMLSerializer: the XML serialization of DOM Parsing (and Chrome's output)
// for the nodes of dom.ts. A parsed document comes back as it was written,
// with its namespace declarations where they were, the XML declaration, the
// DOCTYPE without its internal subset, empty elements as <a/>, and the
// escaping of the browser: & < > in text; & < > " and tab, line feed and
// carriage return (as character references) in attribute values. A tree
// edited through the DOM gets the namespace declarations it needs: xmlns=""
// or xmlns="ns" when an element's namespace is not the default in scope,
// xmlns:p="ns" for a prefix not bound to its namespace, ns1, ns2... for a
// namespaced attribute without a usable prefix.
//
// Elements of the XHTML namespace follow the rule of DOM Parsing for them,
// in XML and HTML documents alike, as Chrome does: an empty void element is
// <br />, any other empty one <p></p> (never <p/>). An element is written
// with its prefix and localName, which for an element of an HTML document is
// the lowercase name the markup had (its tagName is uppercase). The text of
// script and style is escaped as any other: the output is XML, as the
// browser's XMLSerializer gives for an HTML document (xmldom wrote it raw).

import {
    Attr,
    CDATASection,
    Comment,
    Document,
    DocumentFragment,
    DocumentType,
    Element,
    Node,
    ProcessingInstruction,
    Text,
    XHTML_NS,
    XML_NS,
    XMLNS_NS
} from "./dom.ts";

// the elements DOM Parsing writes as <name /> when empty
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
    "menuitem",
    "meta",
    "param",
    "source",
    "track",
    "wbr"
]);

// prefix -> namespace in scope; an element that declares prefixes gets an
// object whose prototype is its parent's (copy on write)
type Prefixes = Record<string, string | null>;

const ROOT_PREFIXES: Prefixes = Object.assign(Object.create(null), {
    xml: XML_NS,
    xmlns: XMLNS_NS
});

export class XMLSerializer {
    serializeToString(node: Node): string {
        if (!(node instanceof Node)) {
            throw new TypeError(
                "Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'."
            );
        }
        return new Serialization().node(node, null, ROOT_PREFIXES);
    }
    get [Symbol.toStringTag]() {
        return "XMLSerializer";
    }
}

class Serialization {
    // generated prefixes (ns1, ns2...) are numbered per call, as in Chrome
    generated = 0;

    node(node: Node, defaultNamespace: string | null, prefixes: Prefixes) {
        if (node instanceof Element) {
            return this.element(node, defaultNamespace, prefixes);
        }
        if (node instanceof Text) {
            return node instanceof CDATASection
                ? "<![CDATA[" + node.data + "]]>"
                : escapeText(node.data);
        }
        if (node instanceof Comment) return "<!--" + node.data + "-->";
        if (node instanceof ProcessingInstruction) {
            return "<?" + node.target + " " + node.data + "?>";
        }
        if (node instanceof Document) {
            return (
                xmlDeclaration(node) +
                this.children(node, defaultNamespace, prefixes)
            );
        }
        if (node instanceof DocumentFragment) {
            return this.children(node, defaultNamespace, prefixes);
        }
        if (node instanceof DocumentType) return doctype(node);
        // an Attr serializes to nothing
        return "";
    }

    children(
        parent: Node,
        defaultNamespace: string | null,
        prefixes: Prefixes
    ) {
        const children = parent._children;
        if (children === null) return "";
        let out = "";
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            // elements and text make the bulk of a document: no dispatch
            out +=
                child instanceof Element
                    ? this.element(child, defaultNamespace, prefixes)
                    : child.constructor === Text
                      ? escapeText((child as Text).data)
                      : this.node(child, defaultNamespace, prefixes);
        }
        return out;
    }

    element(
        element: Element,
        inheritedDefault: string | null,
        inheritedPrefixes: Prefixes
    ): string {
        const attributes = element._attributes;
        const namespace = element.namespaceURI;
        const prefix = element.prefix;
        let defaultNamespace = inheritedDefault;
        let prefixes = inheritedPrefixes;
        // the qualified name: the tagName, but for an HTML element of an HTML
        // document, whose tagName is uppercase
        const qualifiedName =
            prefix === null
                ? element.localName
                : prefix + ":" + element.localName;
        let out = "<" + qualifiedName;
        // a declaration on the element that would contradict its own
        // namespace is replaced by the right one
        let skipped: Attr | null = null;

        // the declarations the element carries
        if (attributes !== null) {
            for (let i = 0; i < attributes.length; i++) {
                const attr = attributes[i];
                if (attr.namespaceURI !== XMLNS_NS) continue;
                if (attr.prefix === null) {
                    defaultNamespace = attr.value || null;
                    if (prefix === null && defaultNamespace !== namespace) {
                        skipped = attr;
                        defaultNamespace = inheritedDefault;
                    }
                } else {
                    if (prefixes === inheritedPrefixes) {
                        prefixes = Object.create(inheritedPrefixes);
                    }
                    prefixes[attr.localName] = attr.value;
                    if (attr.localName === prefix && attr.value !== namespace) {
                        skipped = attr;
                        prefixes[prefix] = inheritedPrefixes[prefix];
                    }
                }
            }
        }

        // the element's own namespace
        if (prefix === null) {
            if (defaultNamespace !== namespace) {
                out += ' xmlns="' + escapeAttribute(namespace ?? "") + '"';
                defaultNamespace = namespace;
            }
        } else if (prefixes[prefix] !== namespace) {
            if (prefixes === inheritedPrefixes) {
                prefixes = Object.create(inheritedPrefixes);
            }
            prefixes[prefix] = namespace;
            out += " xmlns:" + prefix + '="' + escapeAttribute(namespace) + '"';
        }

        if (attributes !== null) {
            for (let i = 0; i < attributes.length; i++) {
                const attr = attributes[i];
                if (attr === skipped) continue;
                const attrNamespace = attr.namespaceURI;
                let name = attr.name;
                if (attrNamespace === XML_NS) {
                    name = "xml:" + attr.localName;
                } else if (
                    attrNamespace !== null &&
                    attrNamespace !== XMLNS_NS &&
                    (attr.prefix === null ||
                        prefixes[attr.prefix] !== attrNamespace)
                ) {
                    let attrPrefix = attr.prefix;
                    if (
                        attrPrefix === null ||
                        (prefixes[attrPrefix] !== undefined &&
                            prefixes[attrPrefix] !== attrNamespace)
                    ) {
                        attrPrefix = this.generatePrefix(prefixes);
                    }
                    if (prefixes === inheritedPrefixes) {
                        prefixes = Object.create(inheritedPrefixes);
                    }
                    prefixes[attrPrefix] = attrNamespace;
                    out +=
                        " xmlns:" +
                        attrPrefix +
                        '="' +
                        escapeAttribute(attrNamespace) +
                        '"';
                    name = attrPrefix + ":" + attr.localName;
                }
                out += " " + name + '="' + escapeAttribute(attr.value) + '"';
            }
        }

        const children = element._children;
        if (children === null || children.length === 0) {
            if (namespace !== XHTML_NS) return out + "/>";
            return VOID_ELEMENTS.has(element.localName)
                ? out + " />"
                : out + "></" + qualifiedName + ">";
        }
        return (
            out +
            ">" +
            this.children(element, defaultNamespace, prefixes) +
            "</" +
            qualifiedName +
            ">"
        );
    }

    generatePrefix(prefixes: Prefixes) {
        let prefix: string;
        do prefix = "ns" + ++this.generated;
        while (prefixes[prefix] !== undefined);
        return prefix;
    }
}

function xmlDeclaration(doc: Document) {
    const declaration = doc._xmlDeclaration;
    if (declaration === null) return "";
    let out = '<?xml version="1.0"';
    if (declaration.encoding !== null) {
        out += ' encoding="' + declaration.encoding + '"';
    }
    if (declaration.standalone !== null) {
        out += ' standalone="' + (declaration.standalone ? "yes" : "no") + '"';
    }
    return out + "?>";
}

function doctype(node: DocumentType) {
    let out = "<!DOCTYPE " + node.name;
    if (node.publicId) out += ' PUBLIC "' + node.publicId + '"';
    else if (node.systemId) out += " SYSTEM";
    if (node.systemId) out += ' "' + node.systemId + '"';
    return out + ">";
}

// The escapes scan with charCodeAt and return the string itself when there
// is nothing to escape, which is most text of most documents.

function escapeText(text: string): string {
    let i = 0;
    for (; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 0x26 || c === 0x3c || c === 0x3e) break;
    }
    if (i === text.length) return text;
    let out = text.slice(0, i);
    let segment = i;
    for (; i < text.length; i++) {
        const c = text.charCodeAt(i);
        const escaped =
            c === 0x26
                ? "&amp;"
                : c === 0x3c
                  ? "&lt;"
                  : c === 0x3e
                    ? "&gt;"
                    : null;
        if (escaped !== null) {
            out += text.slice(segment, i) + escaped;
            segment = i + 1;
        }
    }
    return out + text.slice(segment);
}

const ATTRIBUTE_ESCAPES: Record<number, string> = {
    0x09: "&#9;",
    0x0a: "&#10;",
    0x0d: "&#13;",
    0x22: "&quot;",
    0x26: "&amp;",
    0x3c: "&lt;",
    0x3e: "&gt;"
};

function escapeAttribute(value: string): string {
    let out = "";
    let segment = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        // the escaped characters are all below "?" (0x3f)
        if (c > 0x3e) continue;
        const escaped = ATTRIBUTE_ESCAPES[c];
        if (escaped !== undefined) {
            out += value.slice(segment, i) + escaped;
            segment = i + 1;
        }
    }
    return segment === 0 ? value : out + value.slice(segment);
}
