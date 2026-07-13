import { BridgeNodeInit } from "./node.ts";
import { BridgeAppleInit } from "./apple.ts";
import { isWorker } from "../isWorker.ts";
import { BridgeWindowsInit } from "./windows.ts";

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

if (isWorker) {
    self.addEventListener("message", (event: MessageEvent) => {
        if (event.data && event.data.type === "on-stream-data") {
            globalThis.fullstacked.onStreamData(event.data.streamId, event.data.payload);
        }
    });
}

// nodejs
if (globalThis.process) {
    platformBridge = {
        ready: Promise.resolve(),
        bridge: {
            get ctx() {
                return globalThis.ctxId;
            },
            Async: (payload: ArrayBuffer) =>
                globalThis.bridges.Async(payload) as Promise<ArrayBuffer>,
            Sync: (payload: ArrayBuffer) => globalThis.bridges.Sync(payload) as ArrayBuffer
        }
    };
}
// every other platform (browser)
else {
    globalThis.global = globalThis;
    platformBridge = {
        ready: new Promise<void>(async (resolve, reject) => {
            if (isWorker) {
                await new Promise<void>((workerReady) => {
                    self.onmessage = () => workerReady();
                });
            }

            let platform: string;
            const failedPlatformRequest = () => {
                reject(new Error("Unable to resolve platform"));
            };
            try {
                const platformRequest = await fetch("/platform");
                if (!platformRequest.ok || platformRequest.status > 299) {
                    return failedPlatformRequest();
                }
                platform = await platformRequest.text();
            } catch {
                return failedPlatformRequest();
            }

            switch (platform) {
                case "node":
                    platformBridge.bridge = await BridgeNodeInit();
                    break;
                case "apple":
                    platformBridge.bridge = await BridgeAppleInit();
                    break;
                case "windows":
                    platformBridge.bridge = await BridgeWindowsInit();
                    break;
            }

            resolve();
        })
    };
}

export default platformBridge;
