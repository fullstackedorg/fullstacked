import { BridgeNodeInit } from "./node.ts";
import { BridgeAppleInit } from "./apple.ts";

export interface PlatformBridge {
    ctx: number;
    Async: (payload: ArrayBuffer) => Promise<ArrayBuffer>;
    Sync: (payload: ArrayBuffer) => ArrayBuffer | void;
    GetResponseSync?: (id: number) => ArrayBuffer;
}

let platformBridge: {
    ready: Promise<void>;
    bridge?: PlatformBridge;
} = null;

if (globalThis.process) {
    platformBridge = {
        ready: new Promise<void>((res) => res()),
        bridge: {
            get ctx() {
                return globalThis.ctxId;
            },
            Async: (payload: ArrayBuffer) =>
                globalThis.bridges.Async(payload) as Promise<ArrayBuffer>,
            Sync: (payload: ArrayBuffer) =>
                globalThis.bridges.Sync(payload) as ArrayBuffer
        }
    };
} else {
    globalThis.global = globalThis;
    platformBridge = {
        ready: new Promise<void>(async (res) => {
            // @ts-ignore
            await import("fetch");
            await import("process");

            const platform = await (
                await globalThis.originalFetch("/platform")
            ).text();
            switch (platform) {
                case "node":
                    platformBridge.bridge = await BridgeNodeInit();
                    break;
                case "apple":
                    platformBridge.bridge = await BridgeAppleInit();
                    break;
            }
            res();
        })
    };
}

export default platformBridge;
