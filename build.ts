// events : https://www.npmjs.com/package/events
// util : https://www.npmjs.com/package/util
// string_decoder : https://www.npmjs.com/package/string_decoder
// buffer : https://www.npmjs.com/package/buffer
// stream : https://www.npmjs.com/package/readable-stream
// process : https://www.npmjs.com/package/process
// crypto : https://www.npmjs.com/package/crypto-browserify
// zlib : https://www.npmjs.com/package/browserify-zlib

import esbuild from "esbuild";

const packagesToBundle = [
    {
        entryPoint: "node_modules/events/events.js",
        outfile: "core/internal/bundle/lib/events/index.js"
    },
    {
        entryPoint: "node_modules/util/util.js",
        outfile: "core/internal/bundle/lib/util/index.js"
    },
    {
        entryPoint: "node_modules/string_decoder/lib/string_decoder.js",
        outfile: "core/internal/bundle/lib/string_decoder/index.js"
    },
    {
        entryPoint: "node_modules/buffer/index.js",
        outfile: "core/internal/bundle/lib/buffer/index.js"
    },
    {
        entryPoint: "node_modules/readable-stream/lib/ours/browser.js",
        outfile: "core/internal/bundle/lib/stream/index.js"
    },
    {
        entryPoint: "node_modules/process/browser.js",
        outfile: "core/internal/bundle/lib/process/index.js"
    },
    {
        entryPoint: "node_modules/crypto-browserify/index.js",
        outfile: "core/internal/bundle/lib/crypto/index.js"
    },
    {
        entryPoint: "node_modules/browserify-zlib/lib/index.js",
        outfile: "core/internal/bundle/lib/zlib/index.js"
    }
];

packagesToBundle.forEach(({ entryPoint, outfile }) =>
    esbuild.buildSync({
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        // format: "esm",
        platform: "node",
        external: ["process/"]
    })
);
