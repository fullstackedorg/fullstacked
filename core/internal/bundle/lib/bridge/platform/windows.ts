import type { PlatformBridge } from "./index.ts";
import { isWorker } from "../isWorker.ts";
import { readFrameSharedBuffers } from "../frames.ts";
import { postCall, postSync, relayCall } from "./transport.ts";

export async function BridgeWindowsInit(): Promise<PlatformBridge> {
    const ctx = await (await fetch("/ctx")).json();

    if (!isWorker) {
        globalThis.fullstacked.exit = () =>
            globalThis.fullstacked.fetch("/exit");

        globalThis.fullstacked.open = (ctx: number) =>
            globalThis.fullstacked.fetch(`/open?ctx=${ctx}`);

        globalThis.fullstacked.window.getSize = () =>
            globalThis.fullstacked.fetch("/resize").then((r) => r.text());

        globalThis.fullstacked.window.resize = function (size: string) {
            globalThis.fullstacked.fetch(`/resize?size=${size}`);
        };
    }

    // stream data as binary frames, workers get theirs through the main thread
    if (!isWorker) {
        await readFrameSharedBuffers(globalThis.chrome.webview);
    }

    return {
        ctx,
        Async: isWorker ? relayCall : postCall,
        Sync: postSync
    };
}
