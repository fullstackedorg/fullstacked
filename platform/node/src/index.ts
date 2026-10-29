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

        // the page of a webview reads its stream data on GET /stream, what
        // comes while no page reads it (or once the webview closed) is lost
    }
);

// Node exits once nothing runs: an open stream of the core (a socket, a
// tunnel, a response being read...) keeps it running like a socket would,
// see keepAlive in core/internal/bundle/lib/bridge/duplex.ts
let openStreams = 0;
let ended = false;
const keepAliveHandle = setInterval(() => {}, 1 << 30);
keepAliveHandle.unref();
globalThis.fullstacked.keepAlive = (delta) => {
    openStreams = Math.max(0, openStreams + delta);
    if (openStreams > 0 && !ended) {
        keepAliveHandle.ref();
    } else {
        keepAliveHandle.unref();
    }
};

const forcefullyExit = () => {
    stop();
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

// the dev server (fullstacked [directory]) runs until stopped, whether a
// page is open or not
export function keepRunning() {
    globalThis.fullstacked.keepAlive?.(1);
}

// ends the core (its stream data is dropped, calls into it throw) and
// lets the process exit
export function stop() {
    if (ended) return;
    ended = true;
    keepAliveHandle.unref();
    clearInterval(keepAliveHandle);
    core.end();
}
