#!/usr/bin/env node
import path from "node:path";
import url from "node:url";
import { load } from "./core";
import { bundle } from "../../../core/internal/bundle/lib/bundle";
import { createWebView } from "./webview";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

let webview: Awaited<ReturnType<typeof createWebView>> = null;

const core = await load(
    currentDirectory,
    currentDirectory,
    (ctx: number, streamId: number, buffer: ArrayBuffer) => {
        if (webview) {
            webview.callback(streamId, buffer);
        } else {
            console.log(ctx, streamId, buffer);
        }
    },
    true
);

const mainCtx = core.start(process.cwd());

globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

const result = await bundle(process.argv.at(-1));

result.Warnings?.forEach((w) => console.log(w));
result.Errors?.forEach((e) => console.log(e));

if (result.Errors === null || result.Errors?.length === 0) {
    webview = await createWebView(core, process.cwd(), true);
} else {
    process.exit();
}
