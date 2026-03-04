import { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";

const asyncResponsePromises = new Map<
    number,
    (response: ArrayBuffer) => void
>();

export async function BridgeAppleInit(): Promise<PlatformBridge> {
    globalThis.respond = function (id: number, responseB64: string) {
        const promise = asyncResponsePromises.get(id);
        promise?.(toByteArray(responseB64).buffer);
        asyncResponsePromises.delete(id);
    };

    const ctx = await (await globalThis.originalFetch("/ctx")).json();

    if (isWorker) {
        globalThis.onmessage = (event) => {
            const buffer: ArrayBuffer = event.data;
            const dataView = new DataView(buffer);
            const id = dataView.getUint8(0);
            const response = new Uint8Array(buffer.byteLength - 1);
            response.set(new Uint8Array(buffer, 1));
            const promise = asyncResponsePromises.get(id);
            promise?.(response.buffer);
            asyncResponsePromises.delete(id);
        }
    }

    return {
        ctx,
        async Async(payload) {
            const dataView = new DataView(payload);
            const id = dataView.getUint8(1);
            return new Promise<ArrayBuffer>((resolve) => {
                asyncResponsePromises.set(id, resolve);
                if (isWorker) {
                    globalThis.postMessage(payload);
                } else {
                    const base64 = fromByteArray(new Uint8Array(payload));
                    globalThis.webkit.messageHandlers.bridge.postMessage(base64);
                }
            });
        },
        Sync(payload) {
            const uint8array = new Uint8Array(payload);
            const id = uint8array[1];
            if (isWorker) {
                globalThis.postMessage(payload);
            } else {
                const base64 = fromByteArray(uint8array);
                globalThis.webkit.messageHandlers.bridge.postMessage(base64);
            }
            const xmlHttpRequest = new XMLHttpRequest();
            xmlHttpRequest.open("POST", `/sync/${id}`, false);
            xmlHttpRequest.send();
            const response = xmlHttpRequest.response;
            return toByteArray(response).buffer;
        }
    };
}
