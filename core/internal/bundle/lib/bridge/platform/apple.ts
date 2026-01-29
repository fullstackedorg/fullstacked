import { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";

const asyncResponsePromises = new Map<
    number,
    (response: ArrayBuffer) => void
>();

export function BridgeAppleInit(): PlatformBridge {
    globalThis.respond = function (id: number, responseB64: string) {
        const promise = asyncResponsePromises.get(id);
        promise?.(toByteArray(responseB64).buffer);
        asyncResponsePromises.delete(id);
    };

    const te = new TextEncoder();

    return {
        ctx: globalThis.ctx,
        async Async(payload) {
            const uint8array = new Uint8Array(payload);
            const base64 = fromByteArray(uint8array);
            const id = uint8array[1];
            return new Promise<ArrayBuffer>((resolve) => {
                asyncResponsePromises.set(id, resolve);
                globalThis.webkit.messageHandlers.bridge.postMessage(base64);
            });
        },
        Sync(payload) {
            const uint8array = new Uint8Array(payload);
            const base64 = fromByteArray(uint8array);
            const id = uint8array[1];
            globalThis.webkit.messageHandlers.bridge.postMessage(base64);
            const xmlHttpRequest = new XMLHttpRequest();
            xmlHttpRequest.open("POST", `/sync/${id}`, false);
            xmlHttpRequest.send();
            const response = xmlHttpRequest.response;
            if (typeof response === "string") {
                return te.encode(response).buffer;
            }
            return response;
        }
    };
}
