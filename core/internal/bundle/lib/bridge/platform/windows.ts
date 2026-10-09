import type { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";
import { readFrameSharedBuffers } from "../frames.ts";
import { hybridCall, postSync, relayCall } from "./transport.ts";

// Async calls are web messages: the payload in base64 to
// chrome.webview.postMessage, the replies batched in one message per UI
// tick "R<id>:<base64>;<id>:<base64>...", an empty response when the host
// put it on the frame stream. A request through WebResourceRequested costs
// ~2 ms, so even large payloads are faster as messages.
function messageCall(webview: any) {
    const pending = new Map<number, (response: ArrayBuffer | null) => void>();

    webview.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (typeof data !== "string" || data[0] !== "R") return;
        for (const entry of data.slice(1).split(";")) {
            const separator = entry.indexOf(":");
            if (separator === -1) continue;
            const id = Number(entry.slice(0, separator));
            const response = entry.slice(separator + 1);
            pending.get(id)?.(response ? toByteArray(response).buffer : null);
            pending.delete(id);
        }
    });

    return (payload: ArrayBuffer) =>
        new Promise<ArrayBuffer | null>((resolve) => {
            pending.set(new Uint8Array(payload)[1], resolve);
            webview.postMessage(fromByteArray(new Uint8Array(payload)));
        });
}

export async function BridgeWindowsInit(): Promise<PlatformBridge> {
    const ctx = await (await fetch("/ctx")).json();

    if (isWorker) {
        return {
            ctx,
            Async: relayCall,
            Sync: postSync
        };
    }

    globalThis.fullstacked.exit = () => globalThis.fullstacked.fetch("/exit");

    globalThis.fullstacked.open = (ctx: number) =>
        globalThis.fullstacked.fetch(`/open?ctx=${ctx}`);

    globalThis.fullstacked.window.getSize = () =>
        globalThis.fullstacked.fetch("/resize").then((r) => r.text());

    globalThis.fullstacked.window.resize = function (size: string) {
        globalThis.fullstacked.fetch(`/resize?size=${size}`);
    };

    // stream data as binary frames, workers get theirs through the main thread
    await readFrameSharedBuffers(globalThis.chrome.webview);

    return {
        ctx,
        Async: hybridCall(messageCall(globalThis.chrome.webview), Infinity),
        Sync: postSync
    };
}
