#!/usr/bin/env node
import fullstacked from "../../../core/internal/bundle/lib/fullstacked/index.ts";
import { load } from "./core.ts";
import { createWebView } from "./webview.ts";

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

        throw new Error(`Unknown context: ${ctx}`);
    }
);

const mainCtx = core.start(process.cwd(), process.cwd());

globalThis.ctxId = mainCtx;
globalThis.bridges = {
    ctxId: mainCtx,
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

globalThis.fullstacked.open = (ctx: number) => {
    createWebView(core, ctx, {
        didClose: () => {
            webviews.delete(ctx);
        }
    }).then((webview) => {
        webviews.set(ctx, webview);
    });
};

const code = await fullstacked.execute(process.argv);

const argsThatExits = ["-b", "--build", "-f", "--file", "-h", "--help"];
const shouldExit = !!process.argv.find((arg) =>
    argsThatExits.find((exitArg) => arg.startsWith(exitArg))
);

if ((typeof code === "number" && code !== 0) || shouldExit) {
    end(code);
}
