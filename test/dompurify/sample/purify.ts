import createDOMPurify from "dompurify";

// Where there is no window (a worker, fullstacked --file), DOMPurify is given
// one made of the DOM globals of lib/DOMParser and a document, as it is given
// jsdom's window in Node
export function purifyWithoutWindow() {
    const document = new DOMParser().parseFromString(
        "<!DOCTYPE html>",
        "text/html"
    );
    return createDOMPurify({
        document,
        DOMParser,
        Node,
        Element,
        NodeFilter,
        DocumentFragment,
        NamedNodeMap
    } as any);
}
