import type { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";
import { readFrameStream } from "../frames.ts";
import { responseFrame } from "../responses.ts";
import { POST_MIN_SIZE } from "./transport.ts";

declare global {
    var android: {
        coreCall?: (payloadBase64: string) => string;
        callAsync?: (payloadBase64: string) => void;
        open?: (ctx: number) => void;
        exit?: () => void;
        openUrl?: (url: string) => void;
    };
}

// Injected by the host with WebViewCompat.addWebMessageListener when the
// WebView supports ArrayBuffer messages. Its replies carry the responses of
// async calls as [id][response] ([id] alone when the host put a large one on
// the frame stream), no evaluated script. Small calls are handed over with
// android.callAsync(base64), cheaper than a message, large ones are posted
// to it as an ArrayBuffer. The page posts "init" first so the host keeps the
// reply proxy.
declare global {
    var fullstackedBridge: {
        postMessage(message: ArrayBuffer | string): void;
        onmessage: (event: MessageEvent<ArrayBuffer | string>) => void;
    };
}

const asyncResponsePromises = new Map<
    number,
    (response: ArrayBuffer) => void
>();

export async function BridgeAndroidInit(): Promise<PlatformBridge> {
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
        globalThis.fullstacked.exit = () => globalThis.android?.exit?.();

        globalThis.fullstacked.open = (ctx: number) =>
            globalThis.android?.open?.(ctx);

        globalThis.open = (url: string | URL) => {
            globalThis.android?.openUrl?.(url.toString());
            return null;
        };
    }

    // stream data as binary frames, workers get theirs through the main thread
    if (!isWorker) {
        await readFrameStream();
    }

    let messageBridge = isWorker ? null : globalThis.fullstackedBridge;
    if (messageBridge) {
        const ready = new Promise<boolean>((resolve) => {
            messageBridge.onmessage = (event) => {
                if (typeof event.data === "string") {
                    resolve(event.data === "ready");
                    return;
                }
                const id = new Uint8Array(event.data)[0];
                asyncResponsePromises.get(id)?.(event.data.slice(1));
                asyncResponsePromises.delete(id);
            };
            setTimeout(() => resolve(false), 3000);
        });
        messageBridge.postMessage("init");
        if (!(await ready)) {
            messageBridge = null;
        }
    }

    if (messageBridge) {
        const bridge = messageBridge;
        return {
            ctx,
            // sync calls of workers, they read the response with /sync/{id}
            Send(payload) {
                globalThis.android?.coreCall?.(
                    fromByteArray(new Uint8Array(payload))
                );
            },
            async Async(payload) {
                const id = new Uint8Array(payload)[1];
                const response = await new Promise<ArrayBuffer>((resolve) => {
                    asyncResponsePromises.set(id, resolve);
                    if (payload.byteLength >= POST_MIN_SIZE) {
                        bridge.postMessage(payload);
                    } else {
                        globalThis.android.callAsync(
                            fromByteArray(new Uint8Array(payload))
                        );
                    }
                });
                return response.byteLength ? response : responseFrame(id);
            },
            Sync(payload) {
                return toByteArray(
                    globalThis.android?.coreCall?.(
                        fromByteArray(new Uint8Array(payload))
                    ) || ""
                ).buffer;
            }
        };
    }

    return {
        ctx,
        Send(payload) {
            globalThis.android?.coreCall?.(
                fromByteArray(new Uint8Array(payload))
            );
        },
        async Async(payload) {
            const dataView = new DataView(payload);
            const id = dataView.getUint8(1);
            return new Promise<ArrayBuffer>((resolve) => {
                asyncResponsePromises.set(id, resolve);
                if (messageBridge) {
                    messageBridge.postMessage(payload);
                } else if (isWorker) {
                    // transfer, the payload is not used after
                    globalThis.postMessage(payload, { transfer: [payload] });
                } else {
                    const base64 = fromByteArray(new Uint8Array(payload));
                    globalThis.android?.coreCall?.(base64);
                }
            });
        },
        Sync(payload) {
            const uint8array = new Uint8Array(payload);
            const id = uint8array[1];
            if (isWorker) {
                // transfer, the payload is not used after
                globalThis.postMessage(payload, { transfer: [payload] });
                const xmlHttpRequest = new XMLHttpRequest();
                xmlHttpRequest.open("POST", `/sync/${id}`, false);
                xmlHttpRequest.send();
                const response = xmlHttpRequest.response;
                return toByteArray(response).buffer;
            } else {
                const base64 = fromByteArray(uint8array);
                const responseBase64 =
                    globalThis.android?.coreCall?.(base64) || "";
                return toByteArray(responseBase64).buffer;
            }
        }
    };
}
