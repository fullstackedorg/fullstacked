#!/usr/bin/env node
import path from "node:path";
import { load } from "./core.ts";
import { createWebView } from "./webview.ts";
import { bundle } from "../../../core/internal/bundle/lib/bundle/index.ts";
import plugin from "../../../core/internal/bundle/lib/plugin/index.ts";
import { run } from "../../../core/internal/bundle/lib/run/index.ts";
import version from "../../../core/internal/bundle/lib/process/version.json";
import { findArg, getPositionalArgs } from "./args.ts";
import pluginTailwindcss, {
    initialize
} from "@fullstacked/tailwindcss";

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
            globalThis.callback(streamId, buffer);
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

Options:
  -v, --version Display the current version
  -p, --port    Define the main starting port (defaults to 9000)
  -o, --open    Directly open the browser
  -b, --build   Only bundle, don't run afterward
  -h, --help    Display this help message

Directory:
  The directory to bundle (defaults to ".")
    `);
    process.exit(0);
}

const mainCtx = core.start(directory, directory);

globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

await initialize({
    oxide: "node_modules/oxide-wasm/pkg/oxide_wasm_bg.wasm",
    lightningcss: "node_modules/lightningcss-wasm/lightningcss_node.wasm",
    tailwindcss: "node_modules/tailwindcss",
    baseDirectory: directory
});

await plugin.register("build", pluginTailwindcss);

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
