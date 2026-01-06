#!/usr/bin/env node
import path from "node:path";
import url from "node:url";
import { load } from "./core";
import { bundle } from "../../../core/internal/bundle/lib/bundle";
import { Node } from "../../../core/internal/bundle/lib/@types/bundle";
import { createWebView } from "./webview";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

const core = await load(currentDirectory, currentDirectory, console.log, true);

const mainCtx = core.start(process.cwd());

globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

const result = await bundle(Node, process.argv.at(-1));

result.Warnings?.forEach((w) => console.log(w));
result.Errors?.forEach((e) => console.log(e));

if (result.Errors === null || result.Errors?.length === 0) {
    await createWebView(core, process.cwd(), true);
} else {
    process.exit()
}