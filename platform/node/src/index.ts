#!/usr/bin/env node
import path from "node:path";
import url from "node:url";
import { load } from "./core";
import { bundle } from "../../../core/internal/bundle/lib/bundle";
import { createWebView } from "./webview";
import { execute } from "./cli.ts";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

const core = await load(
    currentDirectory,
    currentDirectory,
    (ctx: number, streamId: number, buffer: ArrayBuffer) => {
        if (webview) {
            webview.callback(streamId, buffer);
        } else {
            globalThis.callback(streamId, buffer);
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

if (process.argv.includes("-c")) {
    await execute(process.argv.slice(process.argv.indexOf("-c") + 1));
    process.exit(0);
}

const result = await bundle(process.argv.at(-1));

result.Warnings?.forEach((w) => console.log(w));
result.Errors?.forEach((e) => console.log(e));

let webview: Awaited<ReturnType<typeof createWebView>> = null;

if (result.Errors === null || result.Errors?.length === 0) {
    webview = await createWebView(core, process.cwd(), true);
} else {
    process.exit();
}
