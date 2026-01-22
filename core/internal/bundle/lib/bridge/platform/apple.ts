import { PlatformBridge } from "./index.ts";
import { fromByteArray, toByteArray } from "../base64.ts";

const responsePromises = new Map<number, (response: ArrayBuffer) => void>();

export function BridgeAppleInit(): PlatformBridge {
    globalThis.respond = function (id: number, responseB64: string) {
        const promise = responsePromises.get(id);
        promise?.(toByteArray(responseB64).buffer);
        responsePromises.delete(id);
    };

    return {
        ctx: globalThis.ctx,
        async Async(payload) {
            const uint8array = new Uint8Array(payload);
            const id = uint8array[1];
            const base64 = fromByteArray(uint8array);
            return new Promise<ArrayBuffer>((resolve) => {
                responsePromises.set(id, resolve);
                globalThis.webkit.messageHandlers.bridge.postMessage(base64);
            });
        },
        Sync(payload) {
            throw "sync bridge not yet implemented";
        }
    };
}
