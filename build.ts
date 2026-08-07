import os from "node:os";
import child_process from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import esbuild from "esbuild";
import version from "./version.ts";
import url from "node:url";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

// shims

// assert : https://www.npmjs.com/package/assert
// events : https://www.npmjs.com/package/events
// util : https://www.npmjs.com/package/util
// string_decoder : https://www.npmjs.com/package/string_decoder
// buffer : https://www.npmjs.com/package/buffer
// stream : https://www.npmjs.com/package/readable-stream
// crypto : https://www.npmjs.com/package/crypto-browserify
// zlib : https://www.npmjs.com/package/browserify-zlib
// querystring : https://www.npmjs.com/package/fast-querystring
// diagnostics_channel : https://www.npmjs.com/package/dc-polyfill
// constants : https://www.npmjs.com/package/constants-browserify
// perf_hooks: https://www.npmjs.com/package/just-performance
// DOMParser : https://www.npmjs.com/package/@xmldom/xmldom

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
    },
    {
        entryPoint: "node_modules/@xmldom/xmldom/lib/index.js",
        outfile: "core/internal/bundle/lib/DOMParser/index.cjs"
    }
];

const alias = {
    // source: https://soatok.blog/2025/11/19/moving-beyond-the-npm-elliptic-package/
    // elliptic: "@soatok/elliptic-to-noble",

    randombytes: "randombytes/browser",
    "create-ecdh": "create-ecdh/browser",
    "create-hash/md5": "create-hash/md5",
    "create-hash": "create-hash/browser",
    "create-hmac": "create-hmac/browser",
    "browserify-cipher": "browserify-cipher/browser",
    "browserify-sign": "browserify-sign/browser",
    "browserify-sign/algos": "browserify-sign/algos"
    // "browserify-aes": "browserify-aes/browser",
};
Object.keys(alias).forEach(
    (key) =>
        (alias[key] = path.join(currentDirectory, "node_modules", alias[key]))
);

packagesToBundle.forEach(({ entryPoint, outfile }) => {
    entryPoint = path.join(currentDirectory, entryPoint);
    outfile = path.join(currentDirectory, outfile);

    entryPoint.endsWith(".json")
        ? fs.cpSync(entryPoint, outfile, { recursive: true })
        : esbuild.buildSync({
              entryPoints: [entryPoint],
              outfile,
              bundle: true,
              // format: "esm",
              platform: "node",
              define: {
                  "process.versions.node": '"0.0.0"'
              },
              external: ["process/", "create-hash/browser/md5"],
              alias
          });
});

// types

child_process.execSync("go run ./generate.go", {
    cwd: path.join(currentDirectory, "types")
});

// version

fs.writeFileSync(
    path.join(
        currentDirectory,
        "core/internal/bundle/lib/process/version.json"
    ),
    JSON.stringify(version)
);

// core

const platform = os.platform();
const arch = os.arch();

if (platform === "win32") {
    child_process.execSync(`call ./windows.bat ${arch}`, {
        stdio: "inherit",
        cwd: path.join(currentDirectory, "core/build")
    });
} else {
    const target_name = platform + "-" + arch + "-shared";
    child_process.execSync(`make ${target_name}`, {
        stdio: "inherit",
        cwd: path.join(currentDirectory, "core/build")
    });
}

// plugins

const pluginsDir = path.join(currentDirectory, "plugins");

async function copyPlugin(plugin: string) {
    const pluginPath = path.join(pluginsDir, plugin);

    if (!fs.existsSync(path.join(pluginPath, "package.json"))) return;

    child_process.execSync("npm run build", {
        cwd: pluginPath,
        stdio: "inherit"
    });

    const pkgJsonPath = path.join(pluginPath, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const pkgName = pkgJson.name;
    const destPath = path.resolve("node_modules", pkgName);

    if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { recursive: true, force: true });
    }

    await fs.promises.cp(pluginPath, destPath, {
        recursive: true,
        force: true,
        filter: (src) => {
            const relative = path.relative(pluginPath, src);
            return !relative.split(path.sep).includes("node_modules");
        }
    });
}

const plugins = (await fs.promises.readdir(pluginsDir, { withFileTypes: true }))
    .filter((dirent) => dirent.isDirectory())
    .map(({ name }) => name);
await Promise.all(plugins.map(copyPlugin));

console.log(
    `\nBuilt FullStacked v${version.major}.${version.minor}.${version.patch}\n` +
        `\tbuild: ${version.build}\n` +
        `\tbranch: ${version.branch}\n` +
        `\thash: ${version.hash.slice(0, 8)}\n` +
        `\tplatform: ${platform}-${arch}\n`
);
