// Conformance of the Node built-ins the runtime serves (improvements/shim/plan.md 4.1):
// each file compares a module of core/internal/bundle/lib with node:<module>.
// The hooks load the shims as the runtime's bundler does; they are registered
// before the files are imported.

import "./hooks.ts";

const tests = [
    "./buffer/index.ts",
    "./events/index.ts",
    "./string_decoder/index.ts",
    "./util/index.ts",
    "./assert/index.ts",
    "./stream/index.ts",
    "./crypto/index.ts",
    "./crypto/primitives.ts",
    "./zlib/index.ts",
    "./querystring/index.ts",
    "./constants/index.ts",
    "./diagnostics_channel/index.ts",
    "./DOMParser/index.ts"
];

for (const test of tests) {
    await import(new URL(test, import.meta.url).toString());
}
