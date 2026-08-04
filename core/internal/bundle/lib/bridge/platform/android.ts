import { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";

declare global {
    var android: {
        coreCall?: (payloadBase64: string) => string;
        open?: (ctx: number) => void;
        exit?: () => void;
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
        globalThis.fullstacked.exit = () =>
            globalThis.android?.exit?.();

        globalThis.fullstacked.open = (ctx: number) =>
            globalThis.android?.open?.(ctx);
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
                    globalThis.android?.coreCall?.(base64);
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
                const xmlHttpRequest = new XMLHttpRequest();
                xmlHttpRequest.open("POST", `/sync/${id}`, false);
                xmlHttpRequest.send();
                const response = xmlHttpRequest.response;
                return toByteArray(response).buffer;
            } else {
                const base64 = fromByteArray(uint8array);
                const responseBase64 = globalThis.android?.coreCall?.(base64) || "";
                return toByteArray(responseBase64).buffer;
            }
        }
    };
}