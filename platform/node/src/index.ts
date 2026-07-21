#!/usr/bin/env node
import "../../../core/internal/bundle/lib/fullstacked/index.ts";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { load } from "./core.ts";
import { createWebView } from "./webview.ts";
import { bundle } from "../../../core/internal/bundle/lib/bundle/index.ts";
import { run } from "../../../core/internal/bundle/lib/run/index.ts";
import version from "../../../core/internal/bundle/lib/process/version.json";
import { findArg, getPositionalArgs } from "./args.ts";
import plugin from "../../../core/internal/bundle/lib/plugin/index.ts";

const end = (code: number) => {
    core.end();
    process.exit(code);
};

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => end(0))
);

const webviews: Map<
    number,
    Awaited<ReturnType<typeof createWebView>>
> = new Map();

const core = await load(
    (ctx: number, streamId: number, buffer: ArrayBuffer) => {
        if (ctx === mainCtx) {
            globalThis.fullstacked.onStreamData(streamId, buffer);
            return;
        }

        const webview = webviews.get(ctx);
        if (webview) {
            webview.callback(streamId, buffer);
            return;
        }

        createWebView(core, ctx, {
            openBrowser: openBrowser || webviews.size >= 1,
            didClose: () => {
                webviews.delete(ctx);
            }
        }).then((webview) => {
            webviews.set(ctx, webview);
        });
    }
);

const help = findArg(["-h", "--help"]);
const showVersion = findArg(["-v", "--version"]);
const openBrowser = findArg(["-o", "--open"]);
const buildOnly = findArg(["-b", "--build"]);
const envArgs = findArg(["-e", "--env"], true);
const pluginsArgs = findArg(["-p", "--plugin"], true);
const env: Record<string, string> = {};
for (const val of envArgs) {
    const index = val.indexOf("=");
    if (index !== -1) {
        const key = val.slice(0, index);
        const value = val.slice(index + 1);
        env[key] = value;
    } else if (val) {
        env[val] = "";
    }
}
const positionalArgs = getPositionalArgs();
const directory = path.resolve(positionalArgs.at(-1) || ".");

if (showVersion) {
    console.log(
        `FullStacked v${version.major}.${version.minor}.${version.patch} (build ${version.build}), branch ${version.branch}, hash ${version.hash.slice(0, 8)}`
    );
    process.exit(0);
}

if (help) {
    console.log(`
Usage: fullstacked [options] [directory]

This CLI compiles and runs projects designed for the FullStacked runtime.
Unlike traditional JS/TS projects with separate frontend and backend layers:
- NodeJS and Browser APIs are available seamlessly within the same files.
- ES module syntax.
- TypeScript support.
- No HTML files.
- Start with an entrypoint: index.js(x) or index.ts(x).

Example:
  // index.jsx
  import React from "react";
  import { createRoot } from "react-dom/client";
  import fs from "node:fs";

  const div = document.createElement("div");
  document.body.append(div);

  const root = createRoot(div);
  root.render(<h1>{await fs.promises.readFile("hello-world.txt")}</h1>);

Options:
  -v, --version Display the current version
  -p, --port    Define the main starting port (defaults to 9000)
  -p, --plugin  Specify a plugin for the build process (can be used multiple times)
  -e, --env     Define environment variables in KEY=VALUE format (can be used multiple times)
  -o, --open    Directly open the browser
  -b, --build   Only bundle the project, don't run it afterward
  -h, --help    Display this help message

Directory:
  The directory to bundle (defaults to ".")
    `);
    process.exit(0);
}

process.chdir(directory);

const mainCtx = core.start(directory, directory);

globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

async function importPlugin(p: string) {
    if (p.startsWith(".") || path.isAbsolute(p)) {
        return (await import(pathToFileURL(path.resolve(p)).href)).default;
    }

    try {
        const requireFromCwd = createRequire(
            path.join(process.cwd(), "index.js")
        );
        const resolved = requireFromCwd.resolve(p);
        return (await import(pathToFileURL(resolved).href)).default;
    } catch {
        try {
            const requireFromModule = createRequire(import.meta.url);
            const resolved = requireFromModule.resolve(p);
            return (await import(pathToFileURL(resolved).href)).default;
        } catch {
            return (await import(p)).default;
        }
    }
}

await Promise.all(
    pluginsArgs.map(async (p) =>
        plugin.register("build", await importPlugin(p))
    )
);

const result = await bundle();

if (result.Warnings?.length) {
    console.warn("Warnings:", result.Warnings);
}

if (result.Errors?.length) {
    console.error("Errors:", result.Errors);
    end(1);
} else if (!buildOnly) {
    run({ env });
} else {
    console.log("Build complete.");
    end(0);
}
