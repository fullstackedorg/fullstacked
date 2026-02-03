#!/usr/bin/env node
import path from "node:path";
import url from "node:url";
import { load } from "./core.ts";
import { execute } from "./cli/index.ts";
import { executeBundle } from "./cli/bundle.ts";
import { createWebView } from "./webview.ts";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

let webview: Awaited<ReturnType<typeof createWebView>> | null = null;

const core = await load(
    currentDirectory,
    currentDirectory,
    (ctx: number, streamId: number, buffer: ArrayBuffer) => {
        if (ctx !== mainCtx) {
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

let command = process.argv.slice(2);

// default command
if (command.length === 0) {
    if (await executeBundle()) {
        webview = await createWebView(core, process.cwd(), true);
    } else {
        core.end();
    }
} else {
    await execute(command, core);
    core.end()
}
