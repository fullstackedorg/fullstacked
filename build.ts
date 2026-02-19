import os from "node:os";
import child_process from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import esbuild from "esbuild";

// shims

// assert : https://www.npmjs.com/package/assert
// events : https://www.npmjs.com/package/events
// util : https://www.npmjs.com/package/util
// string_decoder : https://www.npmjs.com/package/string_decoder
// buffer : https://www.npmjs.com/package/buffer
// stream : https://www.npmjs.com/package/readable-stream
// process : https://www.npmjs.com/package/process
// crypto : https://www.npmjs.com/package/crypto-browserify
// zlib : https://www.npmjs.com/package/browserify-zlib
// querystring : https://www.npmjs.com/package/fast-querystring
// diagnostics_channel : https://www.npmjs.com/package/dc-polyfill
// constants : https://www.npmjs.com/package/constants-browserify

const packagesToBundle = [
    {
        entryPoint: "node_modules/assert/build/assert.js",
        outfile: "core/internal/bundle/lib/assert/index.js"
    },
    {
        entryPoint: "node_modules/events/events.js",
        outfile: "core/internal/bundle/lib/events/index.js"
    },
    {
        entryPoint: "node_modules/util/util.js",
        outfile: "core/internal/bundle/lib/util/index.js"
    },
    {
        entryPoint: "node_modules/util/support/types.js",
        outfile: "core/internal/bundle/lib/util/types/index.js"
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
        outfile: "core/internal/bundle/lib/process/process.js"
    },
    {
        entryPoint: "node_modules/crypto-browserify/index.js",
        outfile: "core/internal/bundle/lib/crypto/index.js"
    },
    {
        entryPoint: "node_modules/browserify-zlib/lib/index.js",
        outfile: "core/internal/bundle/lib/zlib/index.js"
    },
    {
        entryPoint: "node_modules/fast-querystring/lib/index.js",
        outfile: "core/internal/bundle/lib/querystring/index.js"
    },
    {
        entryPoint: "node_modules/dc-polyfill/dc-polyfill.js",
        outfile: "core/internal/bundle/lib/diagnostics_channel/index.js"
    },
    {
        entryPoint: "node_modules/constants-browserify/constants.json",
        outfile: "core/internal/bundle/lib/constants/index.json"
    }
];

packagesToBundle.forEach(({ entryPoint, outfile }) =>
    entryPoint.endsWith(".json")
        ? fs.copyFileSync(entryPoint, outfile)
        : esbuild.buildSync({
              entryPoints: [entryPoint],
              outfile,
              bundle: true,
              // format: "esm",
              platform: "node",
              external: ["process/", "create-hash/browser/md5"],
              alias: {
                  // source: https://soatok.blog/2025/11/19/moving-beyond-the-npm-elliptic-package/
                  elliptic: "@soatok/elliptic-to-noble",

                  randombytes: "randombytes/browser",
                  "create-ecdh": "create-ecdh/browser",
                  "create-hash": "create-hash/browser",
                  "create-hmac": "create-hmac/browser"
              }
          })
);

// types

child_process.execSync("go run ./generate.go", { cwd: "types" });

// core

const platform = os.platform();
const arch = os.arch();

if (platform === "win32") {
    child_process.execSync(`call ./windows.bat ${arch}`, {
        stdio: "inherit",
        cwd: "core/build"
    });
} else {
    const target_name = platform + "-" + arch + "-shared";
    child_process.execSync(`make ${target_name}`, {
        stdio: "inherit",
        cwd: "core/build"
    });
}

export const sharedLibLocation = path.resolve(
    "core",
    "bin",
    `${platform}-${arch}.${platform === "win32" ? "dll" : "so"}`
);
