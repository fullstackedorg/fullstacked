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

        createWebView(core, ctx, true, webviews.size === 0).then((webview) => {
            webviews.set(ctx, webview);
        });
    }
);

const directory = path.resolve(process.argv[2] || ".");

const mainCtx = core.start(directory, directory);

globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

const tailwindcssBuilder = await builderTailwindCSS();
tailwindcssBuilder.on("build", (entryfile, outfile) => {
    child_process.spawnSync("tailwindcss", ["-i", entryfile, "-o", outfile], {
        cwd: directory,
        stdio: "inherit"
    });

    tailwindcssBuilder.writeEvent("build-done");
});

const result = await bundle(".");
if (result.Warnings?.length) {
    console.warn("Warnings:", result.Warnings);
}
if (result.Errors?.length) {
    console.error("Errors:", result.Errors);
} else if (!process.argv.includes("-b")) {
    run(".");
} else {
    end();
}
