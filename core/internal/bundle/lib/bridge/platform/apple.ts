import type { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";

const asyncResponsePromises = new Map<
    number,
    (response: ArrayBuffer) => void
>();

const clipboardResponsePromises = new Map<number, (response: string) => void>();

export async function BridgeAppleInit(): Promise<PlatformBridge> {
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
        globalThis.fullstacked.exit = () =>
            globalThis.webkit.messageHandlers.exit.postMessage("");

        globalThis.fullstacked.open = (ctx: number) =>
            globalThis.webkit.messageHandlers.open.postMessage(ctx);

        if (globalThis.webkit.messageHandlers.clipboard) {
            const td = new TextDecoder();
            globalThis.fullstacked.clipboard.respondPaste = (
                id: number,
                responseBase64: string
            ) => {
                const promise = clipboardResponsePromises.get(id);
                promise?.(td.decode(toByteArray(responseBase64)));
                clipboardResponsePromises.delete(id);
            };

            globalThis.fullstacked.clipboard.paste = () => {
                const id = Math.floor(Math.random() * 1000000);
                return new Promise<string>((resolve) => {
                    clipboardResponsePromises.set(id, resolve);
                    globalThis.webkit.messageHandlers.clipboard.postMessage(
                        id.toString()
                    );
                });
            };

            globalThis.fullstacked.clipboard.copy = (text: string) => {
                globalThis.webkit.messageHandlers.clipboard.postMessage({
                    action: "copy",
                    text
                });
            };
        }

        if (globalThis.webkit.messageHandlers.resize) {
            const resizeResponsePromises: ((size: string) => void)[] = [];

            globalThis.fullstacked.window.respondGetSize = function (
                response: string
            ) {
                const resolve = resizeResponsePromises.shift();
                resolve?.(response);
            };

            globalThis.fullstacked.window.resize = function (size: string) {
                globalThis.webkit.messageHandlers.resize.postMessage(size);
            };

            globalThis.fullstacked.window.getSize = function () {
                return new Promise<string>((resolve) => {
                    resizeResponsePromises.push(resolve);
                    globalThis.webkit.messageHandlers.resize.postMessage("get");
                });
            };
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
                    globalThis.postMessage(payload, {
                        targetOrigin: "bridge"
                    });
                } else {
                    const base64 = fromByteArray(new Uint8Array(payload));
                    globalThis.webkit.messageHandlers.bridge.postMessage(
                        base64
                    );
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
