// The differences with Node of the current shims, per module and case name
// (improvements/shim/conformance.md). A listed case runs as a todo; each stage of
// improvements/shim/plan.md empties the lists of the modules it rewrites.

// Empty since Stage 6: the remaining differences are choices, tested as
// such in their module's file (util inspect of a promise and isProxy, zlib
// zstd, DOMParser querySelector and its lenient text/html). A case listed
// here runs as a todo, for a gap found later (an API a new Node version
// adds).
export const KNOWN_FAILURES: Record<string, Record<string, string>> = {};
