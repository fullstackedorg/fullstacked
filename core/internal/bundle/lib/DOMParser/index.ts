// DOMParser, XMLSerializer and the DOM they work on, for workers: the
// webview has no DOMParser there, so lib/fetch installs these exports on
// globalThis when it is missing (the main thread keeps the browser's).
// Everything exported here becomes a global of the worker.
//
// The XML types get the non-validating XML parser, with Chrome's parsererror
// on malformed input. "text/html" gets a lenient HTML parser at the level of
// xmldom's HTML mode, which served DOMParser here before Stage 6: names
// lowercased, void and implicitly closed elements, raw text, the common
// named references, never an error, but no implied <html>/<head>/<body>
// (see parseHTML in parse.ts). querySelector is not provided
// (improvements/shim/plan.md 5.4). See dom.ts for the DOM and parse.ts for
// the parsers.

import { parseHTML, parseXML } from "./parse.ts";
import type { HTMLDocument, XMLDocument } from "./dom.ts";

const XML_TYPES = [
    "text/xml",
    "application/xml",
    "application/xhtml+xml",
    "image/svg+xml"
];

export class DOMParser {
    parseFromString(string: string, type: string): XMLDocument | HTMLDocument {
        type = String(type);
        if (type === "text/html") return parseHTML(String(string));
        if (!XML_TYPES.includes(type)) {
            throw new TypeError(
                `Failed to execute 'parseFromString' on 'DOMParser': The provided value '${type}' is not a valid enum value of type DOMParserSupportedType.`
            );
        }
        return parseXML(String(string), type);
    }
    get [Symbol.toStringTag]() {
        return "DOMParser";
    }
}

export { XMLSerializer } from "./serialize.ts";
export {
    Attr,
    CDATASection,
    CharacterData,
    Comment,
    Document,
    DocumentFragment,
    DocumentType,
    DOMImplementation,
    Element,
    HTMLCollection,
    HTMLDocument,
    NamedNodeMap,
    Node,
    NodeList,
    ProcessingInstruction,
    Text,
    XMLDocument
} from "./dom.ts";
