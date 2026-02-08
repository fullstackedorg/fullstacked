#!/usr/bin/env node
import path from "node:path";
import url from "node:url";
import { load } from "./core.ts";
import { createWebView } from "./webview.ts";
import { bundle } from "../../../core/internal/bundle/lib/bundle/index.ts";
import { run } from "../../../core/internal/bundle/lib/run/index.ts";

const end = () => {
    core.end();
    process.exit();
};

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => process.on(signal, end));

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

const webviews: Map<
    number,
    Awaited<ReturnType<typeof createWebView>>
> = new Map();

const core = await load(
    currentDirectory,
    currentDirectory,
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

        createWebView(core, ctx, true)
            .then((webview) => {
                webviews.set(ctx, webview);
            });
    },
    true
);

const mainCtx = core.start(process.cwd());

globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

const directory = process.argv[2] || ".";
const result = await bundle(directory);
if (result.Warnings?.length) {
    console.warn("Warnings:", result.Warnings);
}
if (result.Errors?.length) {
    console.error("Errors:", result.Errors);
} else if (!process.argv.includes("-b")) {
    run(directory);
} else {
    end();
}
