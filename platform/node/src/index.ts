#!/usr/bin/env node
import path from "node:path";
import child_process from "node:child_process";
import { load } from "./core.ts";
import { createWebView } from "./webview.ts";
import {
    bundle,
    builderTailwindCSS
} from "../../../core/internal/bundle/lib/bundle/index.ts";
import { run } from "../../../core/internal/bundle/lib/run/index.ts";
import version from "../../../core/internal/bundle/lib/process/version.json";

const end = () => {
    core.end();
    process.exit();
};

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => process.on(signal, end));

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
            openBrowser: openBrowser || webviews.size >= 1
        }).then((webview) => {
            webviews.set(ctx, webview);
        });
    }
);

const args = process.argv.slice(2);
const help = args.includes("-h") || args.includes("--help");
const showVersion = args.includes("-v") || args.includes("--version");
const openBrowser = args.includes("-o") || args.includes("--open");
const buildOnly = args.includes("-b") || args.includes("--build");
const positionalArgs = args.filter((arg) => !arg.startsWith("-"));
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

const tailwindcssBuilder = await builderTailwindCSS();
tailwindcssBuilder.on("build", (entryfile, outfile) => {
    child_process.execSync(`tailwindcss -i ${entryfile} -o ${outfile}`, {
        cwd: directory,
        stdio: "inherit"
    });

    tailwindcssBuilder.writeEvent("build-done");
});

const result = await bundle();
if (result.Warnings?.length) {
    console.warn("Warnings:", result.Warnings);
}
if (result.Errors?.length) {
    console.error("Errors:", result.Errors);
} else if (!buildOnly) {
    run();
} else {
    console.log("Build complete.");
    end();
}
