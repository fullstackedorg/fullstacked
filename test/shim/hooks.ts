// Module hooks that load the shims of core/internal/bundle/lib in Node the
// way the runtime's bundler does (core/internal/bundle/bundle.go, the lib
// plugin), so that test/shim compares the code the webview runs: a bare
// built-in imported from inside a lib module resolves to the lib module of
// that name (lib/crypto gets lib/stream and lib/buffer, not node:stream),
// like libModules does; `process/` stays Node's process. Node's own globals
// are left alone: the global process stays Node's, so process.nextTick is a
// real tick here, a setTimeout in the runtime.
//
// test/shim/index.ts registers them before importing the test files; to run
// one file on its own:
//   node --import ./test/shim/hooks.ts --test test/shim/buffer/index.ts

import { registerHooks } from "node:module";
import path from "node:path";
import url from "node:url";

const lib = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "../../core/internal/bundle/lib"
);
const libUrl = url.pathToFileURL(lib).href + "/";

// the shim directories: only imports made from them are remapped, the lib
// modules written here (net, fs, ...) keep resolving as they do in Node today
const SHIMS = [
    "assert",
    "buffer",
    "constants",
    "crypto",
    "diagnostics_channel",
    "events",
    "querystring",
    "stream",
    "string_decoder",
    "util",
    "zlib"
];

// bundle.go libModules, for the names the shims require
const LIB_MODULES: Record<string, string> = {
    assert: "assert/index.ts",
    buffer: "buffer/index.ts",
    constants: "constants/index.ts",
    crypto: "crypto/index.ts",
    diagnostics_channel: "diagnostics_channel/index.ts",
    events: "events/index.ts",
    querystring: "querystring/index.ts",
    stream: "stream/index.ts",
    "stream/consumers": "stream/consumers.ts",
    "stream/promises": "stream/promises.ts",
    "stream/web": "stream/web.ts",
    string_decoder: "string_decoder/index.ts",
    util: "util/index.ts",
    "util/types": "util/types.ts",
    vm: "unavailable/index.ts",
    zlib: "zlib/index.ts"
};

function isShimFile(fileUrl: string | undefined) {
    if (!fileUrl?.startsWith(libUrl)) return false;
    const dir = fileUrl.slice(libUrl.length).split("/")[0];
    return SHIMS.includes(dir);
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (isShimFile(context.parentURL)) {
            const name = specifier.replace(/^node:/, "").replace(/\/$/, "");
            const target = LIB_MODULES[name];
            if (target) {
                return { url: libUrl + target, shortCircuit: true };
            }
        }
        return nextResolve(specifier, context);
    }
});
