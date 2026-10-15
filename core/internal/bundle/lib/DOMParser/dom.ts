// A small DOM for the XML documents DOMParser builds in workers, where the
// webview has none (improvements/shim/plan.md 5.4). The main thread keeps the browser's.
//
// What it provides: the Node tree (childNodes, siblings, parentNode,
// textContent, appendChild/insertBefore/removeChild/replaceChild, cloneNode,
// normalize, lookupNamespaceURI/lookupPrefix, contains), Document with the
// create* factories, getElementsByTagName(NS) and getElementById, Element with
// the attribute methods (plain and NS) and the element navigation of the
// ParentNode/ChildNode mixins, Attr, Text, CDATASection, Comment,
// ProcessingInstruction, DocumentType, DocumentFragment and DOMImplementation.
//
// Different from the browser:
// - childNodes and attributes are live (they are the arrays the tree is made
//   of), but getElementsByTagName(NS) and children return a snapshot: an
//   HTMLCollection that does not follow later edits;
// - NodeList, HTMLCollection and NamedNodeMap are Array subclasses (indexes,
//   length, item(), iteration), so Array.isArray() is true for them and
//   attributes has no named properties (use getNamedItem);
// - no querySelector(All), no innerHTML/outerHTML, no events, no
//   compareDocumentPosition or isEqualNode.
//
// HTML documents (DOMParser's "text/html", parse.ts parseHTML) are an
// HTMLDocument: as in the browser, the tagName of an element of the XHTML
// namespace is uppercase (its localName is lowercase), and createElement,
// getElementsByTagName and the attribute methods taking a name lowercase it
// for such elements. There is no HTMLElement interface (no body, head,
// innerHTML, dataset...): the elements are the Element of an XML document.

export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
export const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_TYPE_NODE = 10;
const DOCUMENT_FRAGMENT_NODE = 11;

function domError(name: string, message: string) {
    return new DOMException(message, name);
}

// Names (XML 1.0 fifth edition, section 2.3), shared with the parser. ASCII
// goes through a table; the rest through the ranges of the spec. Surrogates
// are accepted as name characters: the pair is then a character of the
// astral range, which the spec allows.

// 1: NameStartChar, 2: NameChar only (digits, '-', '.')
export const NAME_CHARS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
    if (
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x41 && c <= 0x5a) ||
        c === 0x5f /* _ */ ||
        c === 0x3a /* : */
    ) {
        NAME_CHARS[c] = 1;
    } else if ((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e) {
        NAME_CHARS[c] = 2;
    }
}

export function isNameStartNonAscii(c: number) {
    return (
        (c >= 0xc0 && c <= 0xd6) ||
        (c >= 0xd8 && c <= 0xf6) ||
        (c >= 0xf8 && c <= 0x2ff) ||
        (c >= 0x370 && c <= 0x37d) ||
        (c >= 0x37f && c <= 0x1fff) ||
        c === 0x200c ||
        c === 0x200d ||
        (c >= 0x2070 && c <= 0x218f) ||
        (c >= 0x2c00 && c <= 0x2fef) ||
        (c >= 0x3001 && c <= 0xfdcf) || // with the surrogates (0xd800-0xdfff)
        (c >= 0xfdf0 && c <= 0xfffd)
    );
}

export function isNameCharNonAscii(c: number) {
    return (
        isNameStartNonAscii(c) ||
        c === 0xb7 ||
        (c >= 0x300 && c <= 0x36f) ||
        c === 0x203f ||
        c === 0x2040
    );
}

// HTML lowercases and uppercases names in ASCII only (an "Ä" stays)
export function asciiLower(name: string) {
    return /[A-Z]/.test(name)
        ? name.replace(/[A-Z]+/g, (m) => m.toLowerCase())
        : name;
}
export function asciiUpper(name: string) {
    return /[a-z]/.test(name)
        ? name.replace(/[a-z]+/g, (m) => m.toUpperCase())
        : name;
}

// The tagName of an element: its qualified name, uppercase for an element of
// the XHTML namespace in an HTML document (DOM "HTML-uppercased qualified
// name"). Computed again when an element changes document.
function tagNameOf(
    owner: Document | null,
    namespace: string | null,
    prefix: string | null,
    localName: string
) {
    const qualifiedName =
        prefix === null ? localName : prefix + ":" + localName;
    return namespace === XHTML_NS && owner instanceof HTMLDocument
        ? asciiUpper(qualifiedName)
        : qualifiedName;
}

function isName(name: string) {
    if (name.length === 0) return false;
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        const ok =
            c < 128
                ? i === 0
                    ? NAME_CHARS[c] === 1
                    : NAME_CHARS[c] !== 0
                : i === 0
                  ? isNameStartNonAscii(c)
                  : isNameCharNonAscii(c);
        if (!ok) return false;
    }
    return true;
}

function validateName(name: string) {
    if (!isName(name)) {
        throw domError(
            "InvalidCharacterError",
            `The string '${name}' is not a valid XML name.`
        );
    }
}

// DOM "validate and extract": the namespace, prefix and local name of a
// qualified name given to a *NS method
function validateAndExtract(namespace: string | null, qualifiedName: string) {
    qualifiedName = String(qualifiedName);
    if (namespace === "" || namespace === undefined) namespace = null;
    validateName(qualifiedName);
    const colon = qualifiedName.indexOf(":");
    let prefix: string | null = null;
    let localName = qualifiedName;
    if (colon !== -1) {
        prefix = qualifiedName.slice(0, colon);
        localName = qualifiedName.slice(colon + 1);
        if (!prefix || !localName || localName.includes(":")) {
            throw domError(
                "InvalidCharacterError",
                `The qualified name '${qualifiedName}' is not valid.`
            );
        }
    }
    if (
        (prefix !== null && namespace === null) ||
        (prefix === "xml" && namespace !== XML_NS) ||
        ((qualifiedName === "xmlns" || prefix === "xmlns") &&
            namespace !== XMLNS_NS) ||
        (namespace === XMLNS_NS &&
            qualifiedName !== "xmlns" &&
            prefix !== "xmlns")
    ) {
        throw domError(
            "NamespaceError",
            `The qualified name '${qualifiedName}' is not valid in namespace '${namespace}'.`
        );
    }
    return { namespace, prefix, localName };
}

// The node lists are the arrays the tree is made of: childNodes is the
// children array of its parent, so it is live. map/filter/slice give plain
// arrays (species), not lists.
//
// The tree holds plain arrays, which get the NodeList (or NamedNodeMap)
// prototype when a user first asks for childNodes (or attributes): the
// constructor of an Array subclass is slow in V8, a fifth of the parse time
// when every element made one.
export class NodeList<T extends Node = Node> extends Array<T> {
    static get [Symbol.species]() {
        return Array;
    }
    item(index: number): T | null {
        return this[index >>> 0] ?? null;
    }
    get [Symbol.toStringTag]() {
        return "NodeList";
    }
}

// getElementsByTagName(NS) and children: a snapshot (not live)
export class HTMLCollection extends Array<Element> {
    static get [Symbol.species]() {
        return Array;
    }
    item(index: number): Element | null {
        return this[index >>> 0] ?? null;
    }
    namedItem(name: string): Element | null {
        for (const element of this) {
            if (element.getAttribute("id") === name) return element;
        }
        return null;
    }
    get [Symbol.toStringTag]() {
        return "HTMLCollection";
    }
}

function asNodeList(list: Node[]): NodeList {
    if (Object.getPrototypeOf(list) !== NodeList.prototype) {
        Object.setPrototypeOf(list, NodeList.prototype);
    }
    return list as NodeList;
}

// a leaf's childNodes: nothing can be inserted in a leaf, one frozen list
// serves them all
const NO_CHILDREN: NodeList = Object.freeze(asNodeList([]));

export class Node {
    static readonly ELEMENT_NODE = ELEMENT_NODE;
    static readonly ATTRIBUTE_NODE = ATTRIBUTE_NODE;
    static readonly TEXT_NODE = TEXT_NODE;
    static readonly CDATA_SECTION_NODE = CDATA_SECTION_NODE;
    static readonly ENTITY_REFERENCE_NODE = 5;
    static readonly ENTITY_NODE = 6;
    static readonly PROCESSING_INSTRUCTION_NODE = PROCESSING_INSTRUCTION_NODE;
    static readonly COMMENT_NODE = COMMENT_NODE;
    static readonly DOCUMENT_NODE = DOCUMENT_NODE;
    static readonly DOCUMENT_TYPE_NODE = DOCUMENT_TYPE_NODE;
    static readonly DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;
    static readonly NOTATION_NODE = 12;

    // the tree links are plain fields, read through getters so that they
    // stay read-only to users; the parser and the mutation methods below
    // write them directly
    _owner: Document | null;
    _parent: Node | null = null;
    _prev: Node | null = null;
    _next: Node | null = null;
    // allocated on the first child: most elements of a document have one
    // text child or none, and the leaves never have any
    _children: Node[] | null = null;

    constructor(owner: Document | null) {
        this._owner = owner;
    }

    get nodeType(): number {
        return 0;
    }
    get nodeName(): string {
        return "";
    }
    get nodeValue(): string | null {
        return null;
    }
    set nodeValue(_value: string | null) {}
    get textContent(): string | null {
        return null;
    }
    set textContent(_value: string | null) {}

    get ownerDocument(): Document | null {
        return this._owner;
    }
    get parentNode(): Node | null {
        return this._parent;
    }
    get parentElement(): Element | null {
        return this._parent instanceof Element ? this._parent : null;
    }
    get previousSibling(): Node | null {
        return this._prev;
    }
    get nextSibling(): Node | null {
        return this._next;
    }
    get childNodes(): NodeList {
        return NO_CHILDREN;
    }
    get firstChild(): Node | null {
        const children = this._children;
        return children && children.length ? children[0] : null;
    }
    get lastChild(): Node | null {
        const children = this._children;
        return children && children.length
            ? children[children.length - 1]
            : null;
    }
    hasChildNodes() {
        return !!this._children && this._children.length > 0;
    }
    get isConnected() {
        let node: Node = this;
        while (node._parent) node = node._parent;
        return node instanceof Document;
    }
    getRootNode(): Node {
        let node: Node = this;
        while (node._parent) node = node._parent;
        return node;
    }
    contains(other: Node | null) {
        for (let node = other; node; node = node._parent) {
            if (node === this) return true;
        }
        return false;
    }
    isSameNode(other: Node | null) {
        return this === other;
    }

    appendChild<T extends Node>(node: T): T {
        return this.insertBefore(node, null);
    }

    insertBefore<T extends Node>(node: T, child: Node | null): T {
        checkInsert(this, node, child, null);
        if (child === node) child = node._next;
        insertNode(this, node, child);
        return node;
    }

    replaceChild<T extends Node>(node: Node, child: T): T {
        checkNode(child);
        if (child._parent !== this) {
            throw domError(
                "NotFoundError",
                "The node to be replaced is not a child of this node."
            );
        }
        checkInsert(this, node, null, child);
        if (node === child) return child;
        const reference = child._next === node ? node._next : child._next;
        removeNode(child);
        insertNode(this, node, reference);
        return child;
    }

    removeChild<T extends Node>(child: T): T {
        checkNode(child);
        if (child._parent !== this) {
            throw domError(
                "NotFoundError",
                "The node to be removed is not a child of this node."
            );
        }
        removeNode(child);
        return child;
    }

    cloneNode(deep = false): Node {
        return cloneInto(this, this._owner, deep);
    }

    // merges adjacent Text nodes (not CDATA sections) and drops empty ones
    normalize() {
        const children = this._children;
        if (!children) return;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === TEXT_NODE) {
                const text = child as Text;
                let next = text._next;
                while (next && next.nodeType === TEXT_NODE) {
                    text.data += (next as Text).data;
                    removeNode(next);
                    next = text._next;
                }
                if (text.data === "") {
                    removeNode(text);
                    i--;
                }
            } else {
                child.normalize();
            }
        }
    }

    lookupNamespaceURI(prefix: string | null): string | null {
        if (prefix === "") prefix = null;
        const element = closestElement(this);
        return element ? locateNamespace(element, prefix) : null;
    }
    lookupPrefix(namespace: string | null): string | null {
        if (!namespace) return null;
        for (
            let element = closestElement(this);
            element;
            element = element.parentElement
        ) {
            if (element.namespaceURI === namespace && element.prefix !== null) {
                return element.prefix;
            }
            for (const attr of element._attributes ?? []) {
                if (attr.prefix === "xmlns" && attr.value === namespace) {
                    return attr.localName;
                }
            }
        }
        return null;
    }
    isDefaultNamespace(namespace: string | null) {
        return (namespace || null) === this.lookupNamespaceURI(null);
    }

    get [Symbol.toStringTag]() {
        return "Node";
    }
}

// the constants on instances too: node.ELEMENT_NODE
for (const [key, value] of Object.entries(Node)) {
    if (key.endsWith("_NODE")) {
        Object.defineProperty(Node.prototype, key, { value, enumerable: true });
    }
}

function checkNode(node: unknown): asserts node is Node {
    if (!(node instanceof Node)) {
        throw new TypeError("parameter is not of type 'Node'.");
    }
}

function closestElement(node: Node): Element | null {
    if (node instanceof Element) return node;
    if (node instanceof Document) return node.documentElement;
    if (node instanceof Attr) return node.ownerElement;
    if (node instanceof DocumentType || node instanceof DocumentFragment) {
        return null;
    }
    return node.parentElement;
}

function locateNamespace(element: Element, prefix: string | null) {
    if (prefix === "xml") return XML_NS;
    if (prefix === "xmlns") return XMLNS_NS;
    for (let e = element; e; e = e.parentElement) {
        if (e.namespaceURI !== null && e.prefix === prefix) {
            return e.namespaceURI;
        }
        for (const attr of e._attributes ?? []) {
            if (attr.namespaceURI !== XMLNS_NS) continue;
            if (
                prefix === null
                    ? attr.prefix === null && attr.localName === "xmlns"
                    : attr.prefix === "xmlns" && attr.localName === prefix
            ) {
                return attr.value || null;
            }
        }
    }
    return null;
}

// DOM "ensure pre-insertion validity", for insertBefore/appendChild
// (reference = the child to insert before) and replaceChild (replaced = the
// child being replaced, which does not count as present)
function checkInsert(
    parent: Node,
    node: Node,
    reference: Node | null,
    replaced: Node | null
) {
    checkNode(node);
    if (
        !(parent instanceof Element) &&
        !(parent instanceof Document) &&
        !(parent instanceof DocumentFragment)
    ) {
        throw domError(
            "HierarchyRequestError",
            "This node type does not support this method."
        );
    }
    if (node.contains(parent)) {
        throw domError(
            "HierarchyRequestError",
            "The new child element contains the parent."
        );
    }
    if (reference && reference._parent !== parent) {
        throw domError(
            "NotFoundError",
            "The node before which the new node is to be inserted is not a child of this node."
        );
    }
    if (
        node instanceof Document ||
        node instanceof Attr ||
        (node instanceof DocumentType && !(parent instanceof Document)) ||
        (node instanceof Text && parent instanceof Document)
    ) {
        throw domError(
            "HierarchyRequestError",
            `Nodes of type '${node.nodeName}' may not be inserted inside nodes of type '${parent.nodeName}'.`
        );
    }
    if (!(parent instanceof Document)) return;
    // a document holds one element and one doctype at most, and no text
    const incoming =
        node instanceof DocumentFragment ? [...node.childNodes] : [node];
    const present = parent.childNodes.filter(
        (child) => child !== replaced && child !== node
    );
    const count = (nodes: Node[], type: Function) =>
        nodes.filter((n) => n instanceof type).length;
    if (
        incoming.some((n) => n instanceof Text) ||
        count(incoming, Element) + count(present, Element) > 1 ||
        count(incoming, DocumentType) + count(present, DocumentType) > 1
    ) {
        throw domError(
            "HierarchyRequestError",
            "Only one element and one doctype are allowed on Document."
        );
    }
}

function insertNode(parent: Node, node: Node, reference: Node | null) {
    if (node instanceof DocumentFragment) {
        for (const child of [...node.childNodes]) {
            insertNode(parent, child, reference);
        }
        return;
    }
    if (node._parent) removeNode(node);
    const owner = parent instanceof Document ? parent : parent._owner;
    if (node._owner !== owner) adopt(node, owner);
    const children = (parent._children ??= []);
    const index = reference ? children.indexOf(reference) : children.length;
    const prev = index > 0 ? children[index - 1] : null;
    node._parent = parent;
    node._prev = prev;
    node._next = reference;
    if (prev) prev._next = node;
    if (reference) reference._prev = node;
    children.splice(index, 0, node);
}

function removeNode(node: Node) {
    const children = node._parent._children;
    children.splice(children.indexOf(node), 1);
    if (node._prev) node._prev._next = node._next;
    if (node._next) node._next._prev = node._prev;
    node._parent = node._prev = node._next = null;
}

function adopt(node: Node, owner: Document) {
    node._owner = owner;
    if (node instanceof Element) {
        node.tagName = tagNameOf(
            owner,
            node.namespaceURI,
            node.prefix,
            node.localName
        );
        for (const attr of node._attributes ?? []) attr._owner = owner;
    }
    for (const child of node._children ?? []) adopt(child, owner);
}

// the tree builder of the parser: append without the checks (the parser
// only builds valid trees) and without indexOf
export function appendParsed(parent: Node, node: Node) {
    const children = parent._children;
    node._parent = parent;
    if (children === null) {
        parent._children = [node];
        return;
    }
    // empty once its nodes have been removed
    const prev = children.length ? children[children.length - 1] : null;
    node._prev = prev;
    if (prev !== null) prev._next = node;
    children.push(node);
}

function cloneInto(node: Node, owner: Document, deep: boolean): Node {
    let copy: Node;
    if (node instanceof Element) {
        const element = new Element(
            owner,
            node.namespaceURI,
            tagNameOf(owner, node.namespaceURI, node.prefix, node.localName),
            node.prefix,
            node.localName
        );
        const attributes: Attr[] = (element._attributes = []);
        for (const attr of node._attributes ?? []) {
            attributes.push(
                new Attr(
                    owner,
                    attr.namespaceURI,
                    attr.name,
                    attr.prefix,
                    attr.localName,
                    attr.value,
                    element
                )
            );
        }
        copy = element;
    } else if (node instanceof Document) {
        const doc =
            node instanceof HTMLDocument
                ? new HTMLDocument()
                : new XMLDocument();
        doc.contentType = node.contentType;
        doc._xmlDeclaration = node._xmlDeclaration;
        copy = doc;
        owner = doc;
    } else if (node instanceof CDATASection) {
        copy = new CDATASection(owner, node.data);
    } else if (node instanceof Text) {
        copy = new Text(owner, node.data);
    } else if (node instanceof Comment) {
        copy = new Comment(owner, node.data);
    } else if (node instanceof ProcessingInstruction) {
        copy = new ProcessingInstruction(owner, node.target, node.data);
    } else if (node instanceof DocumentType) {
        copy = new DocumentType(owner, node.name, node.publicId, node.systemId);
    } else if (node instanceof DocumentFragment) {
        copy = new DocumentFragment(owner);
    } else if (node instanceof Attr) {
        return new Attr(
            owner,
            node.namespaceURI,
            node.name,
            node.prefix,
            node.localName,
            node.value,
            null
        );
    } else {
        throw domError("NotSupportedError", "The node cannot be cloned.");
    }
    if (deep) {
        for (const child of node._children ?? []) {
            appendParsed(copy, cloneInto(child, owner, true));
        }
    }
    return copy;
}

// textContent of an element or fragment: the Text and CDATA descendants
function collectText(node: Node): string {
    const children = node._children;
    if (children === null) return "";
    // the common case: one text child
    if (children.length === 1 && children[0] instanceof Text) {
        return (children[0] as Text).data;
    }
    let out = "";
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof Text) out += child.data;
        else if (child instanceof Element) out += collectText(child);
    }
    return out;
}

function replaceAllText(node: Node, value: string | null) {
    for (const child of [...(node._children ?? [])]) removeNode(child);
    value = value == null ? "" : String(value);
    if (value !== "") {
        appendParsed(node, new Text(node._owner ?? (node as Document), value));
    }
}

// element descendants matching name (a tagName or "*"), in tree order
function byTagName(root: Node, name: string, out: HTMLCollection) {
    const children = root._children;
    if (children === null) return;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof Element) {
            if (name === "*" || child.tagName === name) out.push(child);
            if (child._children !== null) byTagName(child, name, out);
        }
    }
}

// in an HTML document, an element of the XHTML namespace matches the name
// lowercased, whatever its case (DOM "list of elements with qualified name")
function byTagNameHTML(
    root: Node,
    name: string,
    lower: string,
    out: HTMLCollection
) {
    const children = root._children;
    if (children === null) return;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof Element) {
            if (
                name === "*" ||
                (child.namespaceURI === XHTML_NS
                    ? (child.prefix === null
                          ? child.localName
                          : child.prefix + ":" + child.localName) === lower
                    : child.tagName === name)
            ) {
                out.push(child);
            }
            if (child._children !== null) {
                byTagNameHTML(child, name, lower, out);
            }
        }
    }
}

function byTagNameNS(
    root: Node,
    namespace: string | null,
    localName: string,
    out: HTMLCollection
) {
    const children = root._children;
    if (children === null) return;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof Element) {
            if (
                (namespace === "*" || child.namespaceURI === namespace) &&
                (localName === "*" || child.localName === localName)
            ) {
                out.push(child);
            }
            if (child._children !== null) {
                byTagNameNS(child, namespace, localName, out);
            }
        }
    }
}

// the NonDocumentTypeChildNode mixin of Element and CharacterData
function previousElement(node: Node): Element | null {
    for (let sibling = node._prev; sibling; sibling = sibling._prev) {
        if (sibling instanceof Element) return sibling;
    }
    return null;
}
function nextElement(node: Node): Element | null {
    for (let sibling = node._next; sibling; sibling = sibling._next) {
        if (sibling instanceof Element) return sibling;
    }
    return null;
}

function elementChildren(node: Node) {
    const out = new HTMLCollection();
    for (const child of node._children ?? []) {
        if (child instanceof Element) out.push(child);
    }
    return out;
}

// the ParentNode mixin, and getElementsByTagName(NS) of Document and Element
abstract class ParentNode extends Node {
    get childNodes(): NodeList {
        return asNodeList((this._children ??= []));
    }
    get children(): HTMLCollection {
        return elementChildren(this);
    }
    get firstElementChild(): Element | null {
        for (const child of this._children ?? []) {
            if (child instanceof Element) return child;
        }
        return null;
    }
    get lastElementChild(): Element | null {
        const children = this._children ?? [];
        for (let i = children.length - 1; i >= 0; i--) {
            if (children[i] instanceof Element) return children[i] as Element;
        }
        return null;
    }
    get childElementCount(): number {
        let count = 0;
        for (const child of this._children ?? []) {
            if (child instanceof Element) count++;
        }
        return count;
    }
    append(...nodes: (Node | string)[]) {
        for (const node of nodes) this.appendChild(this._toNode(node));
    }
    prepend(...nodes: (Node | string)[]) {
        const first = this.firstChild;
        for (const node of nodes) this.insertBefore(this._toNode(node), first);
    }
    _toNode(node: Node | string) {
        return node instanceof Node
            ? node
            : new Text(this._owner ?? (this as any), String(node));
    }
    getElementsByTagName(qualifiedName: string): HTMLCollection {
        const out = new HTMLCollection();
        const name = String(qualifiedName);
        if ((this._owner ?? this) instanceof HTMLDocument) {
            byTagNameHTML(this, name, asciiLower(name), out);
        } else {
            byTagName(this, name, out);
        }
        return out;
    }
    getElementsByTagNameNS(
        namespace: string | null,
        localName: string
    ): HTMLCollection {
        const out = new HTMLCollection();
        byTagNameNS(this, namespace || null, String(localName), out);
        return out;
    }
}

export class Document extends ParentNode {
    contentType = "application/xml";
    // set by the parser from <?xml ...?>; XMLSerializer writes it back
    _xmlDeclaration: {
        encoding: string | null;
        standalone: boolean | null;
    } | null = null;
    _implementation: DOMImplementation | null = null;

    constructor() {
        super(null);
    }
    get nodeType() {
        return DOCUMENT_NODE;
    }
    get nodeName() {
        return "#document";
    }
    get implementation() {
        return (this._implementation ??= new DOMImplementation());
    }
    get documentElement(): Element | null {
        return this.firstElementChild;
    }
    get doctype(): DocumentType | null {
        for (const child of this._children ?? []) {
            if (child instanceof DocumentType) return child;
        }
        return null;
    }
    get xmlVersion() {
        return "1.0";
    }
    get xmlEncoding() {
        return this._xmlDeclaration?.encoding ?? null;
    }
    get xmlStandalone() {
        return this._xmlDeclaration?.standalone ?? false;
    }
    get characterSet() {
        return "UTF-8";
    }
    get charset() {
        return "UTF-8";
    }
    get inputEncoding() {
        return "UTF-8";
    }
    get URL() {
        return "about:blank";
    }
    get documentURI() {
        return "about:blank";
    }

    createElement(localName: string): Element {
        localName = String(localName);
        validateName(localName);
        // an HTML document creates HTML elements, named in lowercase
        if (this instanceof HTMLDocument) localName = asciiLower(localName);
        const namespace =
            this instanceof HTMLDocument ||
            this.contentType === "application/xhtml+xml"
                ? XHTML_NS
                : null;
        return new Element(
            this,
            namespace,
            tagNameOf(this, namespace, null, localName),
            null,
            localName
        );
    }
    createElementNS(namespace: string | null, qualifiedName: string): Element {
        const name = validateAndExtract(namespace, qualifiedName);
        return new Element(
            this,
            name.namespace,
            tagNameOf(this, name.namespace, name.prefix, name.localName),
            name.prefix,
            name.localName
        );
    }
    createAttribute(localName: string): Attr {
        localName = String(localName);
        validateName(localName);
        return new Attr(this, null, localName, null, localName, "", null);
    }
    createAttributeNS(namespace: string | null, qualifiedName: string): Attr {
        const name = validateAndExtract(namespace, qualifiedName);
        return new Attr(
            this,
            name.namespace,
            String(qualifiedName),
            name.prefix,
            name.localName,
            "",
            null
        );
    }
    createTextNode(data: string): Text {
        return new Text(this, String(data));
    }
    createComment(data: string): Comment {
        return new Comment(this, String(data));
    }
    createCDATASection(data: string): CDATASection {
        data = String(data);
        if (data.includes("]]>")) {
            throw domError(
                "InvalidCharacterError",
                "String cannot contain ']]>' since that is the end delimiter of a CData section."
            );
        }
        return new CDATASection(this, data);
    }
    createProcessingInstruction(
        target: string,
        data: string
    ): ProcessingInstruction {
        target = String(target);
        data = String(data);
        validateName(target);
        if (data.includes("?>")) {
            throw domError(
                "InvalidCharacterError",
                "The data provided ('" + data + "') contains '?>'."
            );
        }
        return new ProcessingInstruction(this, target, data);
    }
    createDocumentFragment(): DocumentFragment {
        return new DocumentFragment(this);
    }
    importNode<T extends Node>(node: T, deep = false): T {
        checkNode(node);
        if (node instanceof Document) {
            throw domError("NotSupportedError", "Cannot import a Document.");
        }
        return cloneInto(node, this, deep) as T;
    }
    adoptNode<T extends Node>(node: T): T {
        checkNode(node);
        if (node instanceof Document) {
            throw domError("NotSupportedError", "Cannot adopt a Document.");
        }
        if (node._parent) removeNode(node);
        if (node instanceof Attr && node.ownerElement) {
            node.ownerElement.removeAttributeNode(node);
        }
        adopt(node, this);
        return node;
    }
    // the elements whose id attribute is elementId (an XML document has no
    // DTD-declared IDs here; the browser does the same for `id`)
    getElementById(elementId: string): Element | null {
        elementId = String(elementId);
        const find = (node: Node): Element | null => {
            for (const child of node._children ?? []) {
                if (child instanceof Element) {
                    if (child.getAttribute("id") === elementId) return child;
                    const found = find(child);
                    if (found) return found;
                }
            }
            return null;
        };
        return find(this);
    }
    get textContent(): string | null {
        return null;
    }
    set textContent(_value: string | null) {}
    get [Symbol.toStringTag]() {
        return "Document";
    }
}

export class XMLDocument extends Document {
    get [Symbol.toStringTag]() {
        return "XMLDocument";
    }
}

// what DOMParser returns for "text/html"; see the header for what changes
export class HTMLDocument extends Document {
    contentType = "text/html";
    get [Symbol.toStringTag]() {
        return "HTMLDocument";
    }
}

export class DocumentFragment extends ParentNode {
    get nodeType() {
        return DOCUMENT_FRAGMENT_NODE;
    }
    get nodeName() {
        return "#document-fragment";
    }
    get textContent(): string {
        return collectText(this);
    }
    set textContent(value: string | null) {
        replaceAllText(this, value);
    }
    getElementById(elementId: string) {
        return Document.prototype.getElementById.call(this, elementId);
    }
    get [Symbol.toStringTag]() {
        return "DocumentFragment";
    }
}

export class DocumentType extends Node {
    name: string;
    publicId: string;
    systemId: string;
    constructor(
        owner: Document,
        name: string,
        publicId: string,
        systemId: string
    ) {
        super(owner);
        this.name = name;
        this.publicId = publicId;
        this.systemId = systemId;
    }
    get nodeType() {
        return DOCUMENT_TYPE_NODE;
    }
    get nodeName() {
        return this.name;
    }
    // the internal subset is skipped by the parser: no declaration is kept
    get internalSubset(): string | null {
        return null;
    }
    remove() {
        if (this._parent) removeNode(this);
    }
    get [Symbol.toStringTag]() {
        return "DocumentType";
    }
}

export class Element extends ParentNode {
    namespaceURI: string | null;
    prefix: string | null;
    localName: string;
    tagName: string;
    // allocated on the first attribute
    _attributes: Attr[] | null = null;

    constructor(
        owner: Document,
        namespaceURI: string | null,
        qualifiedName: string,
        prefix: string | null,
        localName: string
    ) {
        super(owner);
        this.namespaceURI = namespaceURI;
        this.prefix = prefix;
        this.localName = localName;
        this.tagName = qualifiedName;
    }
    get nodeType() {
        return ELEMENT_NODE;
    }
    get nodeName() {
        return this.tagName;
    }
    get textContent(): string {
        return collectText(this);
    }
    set textContent(value: string | null) {
        replaceAllText(this, value);
    }

    get attributes(): NamedNodeMap {
        const attributes = (this._attributes ??= []);
        if (Object.getPrototypeOf(attributes) !== NamedNodeMap.prototype) {
            Object.setPrototypeOf(attributes, NamedNodeMap.prototype);
            // not enumerable: the map lists attributes only
            Object.defineProperty(attributes, "_element", { value: this });
        }
        return attributes as NamedNodeMap;
    }
    hasAttributes() {
        return !!this._attributes && this._attributes.length > 0;
    }
    getAttributeNames(): string[] {
        return (this._attributes ?? []).map((attr) => attr.name);
    }
    // the name of an attribute as the methods taking a qualified name look
    // it up or create it: lowercased on an element of the XHTML namespace in
    // an HTML document, whose parsed attributes are lowercase
    _attributeName(qualifiedName: string) {
        qualifiedName = String(qualifiedName);
        return this.namespaceURI === XHTML_NS &&
            this._owner instanceof HTMLDocument
            ? asciiLower(qualifiedName)
            : qualifiedName;
    }
    getAttributeNode(qualifiedName: string): Attr | null {
        const attributes = this._attributes;
        if (attributes === null) return null;
        qualifiedName = this._attributeName(qualifiedName);
        for (let i = 0; i < attributes.length; i++) {
            if (attributes[i].name === qualifiedName) return attributes[i];
        }
        return null;
    }
    getAttributeNodeNS(
        namespace: string | null,
        localName: string
    ): Attr | null {
        const attributes = this._attributes;
        if (attributes === null) return null;
        namespace = namespace || null;
        localName = String(localName);
        for (let i = 0; i < attributes.length; i++) {
            const attr = attributes[i];
            if (attr.localName === localName && attr.namespaceURI === namespace)
                return attr;
        }
        return null;
    }
    getAttribute(qualifiedName: string): string | null {
        return this.getAttributeNode(qualifiedName)?.value ?? null;
    }
    getAttributeNS(namespace: string | null, localName: string): string | null {
        return this.getAttributeNodeNS(namespace, localName)?.value ?? null;
    }
    hasAttribute(qualifiedName: string) {
        return this.getAttributeNode(qualifiedName) !== null;
    }
    hasAttributeNS(namespace: string | null, localName: string) {
        return this.getAttributeNodeNS(namespace, localName) !== null;
    }
    setAttribute(qualifiedName: string, value: string) {
        qualifiedName = this._attributeName(qualifiedName);
        validateName(qualifiedName);
        const attr = this.getAttributeNode(qualifiedName);
        if (attr) {
            attr.value = String(value);
            return;
        }
        (this._attributes ??= []).push(
            new Attr(
                this._owner,
                null,
                qualifiedName,
                null,
                qualifiedName,
                String(value),
                this
            )
        );
    }
    setAttributeNS(
        namespace: string | null,
        qualifiedName: string,
        value: string
    ) {
        const name = validateAndExtract(namespace, qualifiedName);
        const attr = this.getAttributeNodeNS(name.namespace, name.localName);
        if (attr) {
            attr.value = String(value);
            return;
        }
        (this._attributes ??= []).push(
            new Attr(
                this._owner,
                name.namespace,
                String(qualifiedName),
                name.prefix,
                name.localName,
                String(value),
                this
            )
        );
    }
    removeAttribute(qualifiedName: string) {
        const attr = this.getAttributeNode(qualifiedName);
        if (attr) this.removeAttributeNode(attr);
    }
    removeAttributeNS(namespace: string | null, localName: string) {
        const attr = this.getAttributeNodeNS(namespace, localName);
        if (attr) this.removeAttributeNode(attr);
    }
    setAttributeNode(attr: Attr): Attr | null {
        return this.attributes.setNamedItem(attr);
    }
    setAttributeNodeNS(attr: Attr): Attr | null {
        return this.attributes.setNamedItemNS(attr);
    }
    removeAttributeNode(attr: Attr): Attr {
        const attributes = this._attributes;
        const index = attributes ? attributes.indexOf(attr) : -1;
        if (index === -1) {
            throw domError(
                "NotFoundError",
                "The node provided is owned by another element."
            );
        }
        attributes.splice(index, 1);
        attr.ownerElement = null;
        return attr;
    }

    get previousElementSibling(): Element | null {
        return previousElement(this);
    }
    get nextElementSibling(): Element | null {
        return nextElement(this);
    }
    remove() {
        if (this._parent) removeNode(this);
    }
    get [Symbol.toStringTag]() {
        return "Element";
    }
}

// the attributes array of an element (see NodeList), live
export class NamedNodeMap extends Array<Attr> {
    static get [Symbol.species]() {
        return Array;
    }
    // set when an element's array becomes its NamedNodeMap
    _element: Element;
    item(index: number): Attr | null {
        return this[index >>> 0] ?? null;
    }
    getNamedItem(qualifiedName: string) {
        return this._element.getAttributeNode(qualifiedName);
    }
    getNamedItemNS(namespace: string | null, localName: string) {
        return this._element.getAttributeNodeNS(namespace, localName);
    }
    setNamedItem(attr: Attr): Attr | null {
        return this._set(attr, this.getNamedItem(attr.name));
    }
    setNamedItemNS(attr: Attr): Attr | null {
        return this._set(
            attr,
            this.getNamedItemNS(attr.namespaceURI, attr.localName)
        );
    }
    _set(attr: Attr, old: Attr | null) {
        if (!(attr instanceof Attr)) {
            throw new TypeError("parameter 1 is not of type 'Attr'.");
        }
        if (attr.ownerElement && attr.ownerElement !== this._element) {
            throw domError(
                "InUseAttributeError",
                "The node provided is an attribute node that is already an attribute of another Element; attribute nodes must be explicitly cloned."
            );
        }
        if (old === attr) return attr;
        attr._owner = this._element._owner;
        attr.ownerElement = this._element;
        if (old) {
            this[this.indexOf(old)] = attr;
            old.ownerElement = null;
        } else {
            this.push(attr);
        }
        return old;
    }
    removeNamedItem(qualifiedName: string): Attr {
        return this._remove(this.getNamedItem(qualifiedName));
    }
    removeNamedItemNS(namespace: string | null, localName: string): Attr {
        return this._remove(this.getNamedItemNS(namespace, localName));
    }
    _remove(attr: Attr | null) {
        if (!attr) {
            throw domError(
                "NotFoundError",
                "No item with that name was found."
            );
        }
        return this._element.removeAttributeNode(attr);
    }
    get [Symbol.toStringTag]() {
        return "NamedNodeMap";
    }
}

export class Attr extends Node {
    namespaceURI: string | null;
    // the qualified name
    name: string;
    prefix: string | null;
    localName: string;
    value: string;
    ownerElement: Element | null;

    constructor(
        owner: Document,
        namespaceURI: string | null,
        name: string,
        prefix: string | null,
        localName: string,
        value: string,
        ownerElement: Element | null
    ) {
        super(owner);
        this.namespaceURI = namespaceURI;
        this.name = name;
        this.prefix = prefix;
        this.localName = localName;
        this.value = value;
        this.ownerElement = ownerElement;
    }
    get nodeType() {
        return ATTRIBUTE_NODE;
    }
    get nodeName() {
        return this.name;
    }
    get nodeValue() {
        return this.value;
    }
    set nodeValue(value: string | null) {
        this.value = value == null ? "" : String(value);
    }
    get textContent() {
        return this.value;
    }
    set textContent(value: string | null) {
        this.value = value == null ? "" : String(value);
    }
    get specified() {
        return true;
    }
    get [Symbol.toStringTag]() {
        return "Attr";
    }
}

export abstract class CharacterData extends Node {
    data: string;
    constructor(owner: Document, data: string) {
        super(owner);
        this.data = data;
    }
    get nodeValue() {
        return this.data;
    }
    set nodeValue(value: string | null) {
        this.data = value == null ? "" : String(value);
    }
    get textContent() {
        return this.data;
    }
    set textContent(value: string | null) {
        this.data = value == null ? "" : String(value);
    }
    get length() {
        return this.data.length;
    }
    substringData(offset: number, count: number) {
        this._checkOffset(offset);
        return this.data.substr(offset, count);
    }
    appendData(data: string) {
        this.data += String(data);
    }
    insertData(offset: number, data: string) {
        this.replaceData(offset, 0, data);
    }
    deleteData(offset: number, count: number) {
        this.replaceData(offset, count, "");
    }
    replaceData(offset: number, count: number, data: string) {
        this._checkOffset(offset);
        this.data =
            this.data.slice(0, offset) +
            String(data) +
            this.data.slice(offset + count);
    }
    _checkOffset(offset: number) {
        if (offset > this.data.length) {
            throw domError(
                "IndexSizeError",
                `The offset ${offset} is greater than the node's length (${this.data.length}).`
            );
        }
    }
    get previousElementSibling(): Element | null {
        return previousElement(this);
    }
    get nextElementSibling(): Element | null {
        return nextElement(this);
    }
    remove() {
        if (this._parent) removeNode(this);
    }
}

export class Text extends CharacterData {
    get nodeType() {
        return TEXT_NODE;
    }
    get nodeName() {
        return "#text";
    }
    get wholeText() {
        let start: Node = this;
        while (start._prev instanceof Text) start = start._prev;
        let out = "";
        for (let node = start; node instanceof Text; node = node._next) {
            out += node.data;
        }
        return out;
    }
    splitText(offset: number): Text {
        this._checkOffset(offset);
        const tail = new (this.constructor as typeof Text)(
            this._owner,
            this.data.slice(offset)
        );
        this.data = this.data.slice(0, offset);
        if (this._parent) insertNode(this._parent, tail, this._next);
        return tail;
    }
    get [Symbol.toStringTag]() {
        return "Text";
    }
}

export class CDATASection extends Text {
    get nodeType() {
        return CDATA_SECTION_NODE;
    }
    get nodeName() {
        return "#cdata-section";
    }
    get [Symbol.toStringTag]() {
        return "CDATASection";
    }
}

export class Comment extends CharacterData {
    get nodeType() {
        return COMMENT_NODE;
    }
    get nodeName() {
        return "#comment";
    }
    get [Symbol.toStringTag]() {
        return "Comment";
    }
}

export class ProcessingInstruction extends CharacterData {
    target: string;
    constructor(owner: Document, target: string, data: string) {
        super(owner, data);
        this.target = target;
    }
    get nodeType() {
        return PROCESSING_INSTRUCTION_NODE;
    }
    get nodeName() {
        return this.target;
    }
    get [Symbol.toStringTag]() {
        return "ProcessingInstruction";
    }
}

export class DOMImplementation {
    createDocument(
        namespace: string | null,
        qualifiedName: string | null,
        doctype: DocumentType | null = null
    ): XMLDocument {
        const doc = new XMLDocument();
        if (doctype) doc.appendChild(doctype);
        if (qualifiedName) {
            doc.appendChild(doc.createElementNS(namespace, qualifiedName));
        }
        doc.contentType =
            namespace === XHTML_NS
                ? "application/xhtml+xml"
                : namespace === "http://www.w3.org/2000/svg"
                  ? "image/svg+xml"
                  : "application/xml";
        return doc;
    }
    createDocumentType(
        qualifiedName: string,
        publicId: string,
        systemId: string
    ): DocumentType {
        validateName(String(qualifiedName));
        return new DocumentType(
            null,
            String(qualifiedName),
            String(publicId),
            String(systemId)
        );
    }
    hasFeature() {
        return true;
    }
    get [Symbol.toStringTag]() {
        return "DOMImplementation";
    }
}
