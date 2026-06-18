import { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";

const asyncResponsePromises = new Map<
    number,
    (response: ArrayBuffer) => void
>();

export async function BridgeWindowsInit(): Promise<PlatformBridge> {
    globalThis.respond = function (id: number, responseB64: string) {
        const promise = asyncResponsePromises.get(id);
        promise?.(toByteArray(responseB64).buffer);
        asyncResponsePromises.delete(id);
    };

    const ctx = await (await globalThis.originalFetch("/ctx")).json();

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
        globalThis.exit = () => globalThis.originalFetch("/exit");

        globalThis.resize = function (sizeOrGet: string) {
            if (sizeOrGet === "get") {
                return globalThis
                    .originalFetch("/resize")
                    .then((r) => r.text());
            } else if (sizeOrGet === "fullscreen") {
                return globalThis
                    .originalFetch("/resize?fullscreen=true")
                    .then(() => {});
            } else if (sizeOrGet === "kiosk") {
                return globalThis
                    .originalFetch("/resize?kiosk=true")
                    .then(() => {});
            } else {
                const components = sizeOrGet.split(":");
                let url = "/resize";
                if (components.length === 2) {
                    url += `?width=${components[0]}&height=${components[1]}`;
                } else if (components.length === 4) {
                    url += `?width=${components[0]}&height=${components[1]}&x=${components[2]}&y=${components[3]}`;
                }
                return globalThis.originalFetch(url).then(() => {});
            }
        };
    }

    return {
        ctx,
        async Async(payload) {
            const dataView = new DataView(payload);
            const id = dataView.getUint8(1);
            return new Promise<ArrayBuffer>((resolve) => {
                asyncResponsePromises.set(id, resolve);
                if (isWorker) {
                    globalThis.postMessage(payload, {
                        targetOrigin: "bridge"
                    });
                } else {
                    const base64 = fromByteArray(new Uint8Array(payload));
                    globalThis.chrome.webview.postMessage(base64);
                }
            });
        },
        Sync(payload) {
            const uint8array = new Uint8Array(payload);
            const id = uint8array[1];
            if (isWorker) {
                globalThis.postMessage(payload, {
                    targetOrigin: "bridge"
                });
            } else {
                const base64 = fromByteArray(uint8array);
                globalThis.chrome.webview.postMessage(base64);
            }
            const xmlHttpRequest = new XMLHttpRequest();
            xmlHttpRequest.open("POST", `/sync/${id}`, false);
            xmlHttpRequest.send();
            const response = xmlHttpRequest.response;
            return toByteArray(response).buffer;
        }
    };
}
