import "../../../core/internal/bundle/lib/fullstacked/index.ts";
import { load } from "./core.ts";
import {
    type CreateWebViewOpts,
    createWebViewWithCore,
    staticFileWithCore
} from "./webview.ts";

const webviews: Map<
    number,
    Awaited<ReturnType<typeof createWebViewWithCore>>
> = new Map();

const core = await load(
    (ctx: number, streamId: number, buffer: ArrayBuffer) => {
        if (ctx === globalThis.bridge.ctxId) {
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

const forcefullyExit = () => {
    core.end();
    process.exit();
};
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => {
    process.on(signal, forcefullyExit);
});

globalThis.bridge = {
    ctxId: core.start(process.cwd(), process.cwd()),
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

export async function createWebView(ctx: number, opts?: CreateWebViewOpts) {
    const webview = await createWebViewWithCore(core, ctx, {
        ...opts,
        didClose: () => {
            opts?.didClose?.();
            webviews.delete(ctx);
        }
    });
    webviews.set(ctx, webview);
    return webview;
}

export function staticFileResolve(ctx: number, pathname: string) {
    return staticFileWithCore(core, ctx, pathname);
}

globalThis.fullstacked.open = createWebView;

export function stop() {
    core.end();
}
