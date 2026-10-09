import type { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";
import { readFrameStream } from "../frames.ts";
import {
    hostSupportsBinaryCalls,
    hybridCall,
    postSync,
    relayCall
} from "./transport.ts";

const asyncResponsePromises = new Map<
    number,
    (response: ArrayBuffer) => void
>();

declare global {
    var webkit: any;
    var chrome: any;
    var qt: any;
    var bridge: any;
}

export async function BridgeLinuxInit(): Promise<PlatformBridge> {
    globalThis.fullstacked.respond = (id: number, responseBase64: string) => {
        const promise = asyncResponsePromises.get(id);
        promise?.(toByteArray(responseBase64).buffer);
        asyncResponsePromises.delete(id);
    };

    const ctx = await (await fetch("/ctx")).json();

    if (isWorker) {
        globalThis.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer)) {
                return;
            }
            const buffer: ArrayBuffer = event.data;
            const dataView = new DataView(buffer);
            const id = dataView.getUint8(0);
            const response = new Uint8Array(buffer.byteLength - 1);
            response.set(new Uint8Array(buffer, 1));
            const promise = asyncResponsePromises.get(id);
            promise?.(response.buffer);
            asyncResponsePromises.delete(id);
        };
    } else {
        globalThis.fullstacked.exit = () => {
            if (globalThis.webkit?.messageHandlers?.exit) {
                globalThis.webkit.messageHandlers.exit.postMessage("");
            } else {
                (globalThis.fullstacked.fetch || fetch)("/exit");
            }
        };

        globalThis.fullstacked.open = (ctx: number) => {
            if (globalThis.webkit?.messageHandlers?.open) {
                globalThis.webkit.messageHandlers.open.postMessage(ctx);
            } else {
                (globalThis.fullstacked.fetch || fetch)(`/open?ctx=${ctx}`);
            }
        };

        globalThis.fullstacked.window = globalThis.fullstacked.window || {};

        globalThis.fullstacked.window.getSize = () =>
            (globalThis.fullstacked.fetch || fetch)("/resize").then((r) =>
                r.text()
            );

        globalThis.fullstacked.window.resize = function (size: string) {
            (globalThis.fullstacked.fetch || fetch)(`/resize?size=${size}`);
        };
    }

    const postBridgeMessage = (base64: string) => {
        if (globalThis.webkit?.messageHandlers?.bridge) {
            globalThis.webkit.messageHandlers.bridge.postMessage(base64);
        } else if (globalThis.bridge?.postMessage) {
            globalThis.bridge.postMessage(base64);
        } else if (globalThis.chrome?.webview) {
            globalThis.chrome.webview.postMessage(base64);
        }
    };

    // stream data as binary frames, workers get theirs through the main thread
    if (!isWorker) {
        await readFrameStream();
    }

    // A small call on the message channel of the host (QWebChannel on Qt),
    // answered with window.fullstacked.respond, empty when the host put a
    // large response on the frame stream
    const bridgeMessageCall = (payload: ArrayBuffer) => {
        const id = new Uint8Array(payload)[1];
        return new Promise<ArrayBuffer | null>((resolve) => {
            asyncResponsePromises.set(id, (response) =>
                resolve(response.byteLength ? response : null)
            );
            if (isWorker) {
                // transfer, the payload is not used after
                globalThis.postMessage(payload, { transfer: [payload] });
            } else {
                postBridgeMessage(fromByteArray(new Uint8Array(payload)));
            }
        });
    };

    // GTK and Qt >= 6.7 read the request body of POST /call and /sync, older
    // Qt keeps the messages over QWebChannel
    if (await hostSupportsBinaryCalls()) {
        // GTK answers small calls on a message handler with reply
        const callHandler = globalThis.webkit?.messageHandlers?.call;
        const messageCall = callHandler
            ? async (payload: ArrayBuffer) => {
                  const response: string = await callHandler.postMessage(
                      fromByteArray(new Uint8Array(payload))
                  );
                  return response ? toByteArray(response).buffer : null;
              }
            : bridgeMessageCall;
        return {
            ctx,
            Async: isWorker ? relayCall : hybridCall(messageCall),
            Sync: postSync
        };
    }

    return {
        ctx,
        Send(payload) {
            postBridgeMessage(fromByteArray(new Uint8Array(payload)));
        },
        Async: hybridCall(bridgeMessageCall, Infinity),
        Sync(payload) {
            const uint8array = new Uint8Array(payload);
            const id = uint8array[1];
            if (isWorker) {
                // transfer, the payload is not used after
                globalThis.postMessage(payload, { transfer: [payload] });
            } else {
                const base64 = fromByteArray(uint8array);
                postBridgeMessage(base64);
            }
            const xmlHttpRequest = new XMLHttpRequest();
            xmlHttpRequest.open("POST", `/sync/${id}`, false);
            xmlHttpRequest.send();
            const response = xmlHttpRequest.response;
            return toByteArray(response).buffer;
        }
    };
}
