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
        if (event.data && event.data.type === "stream-callback") {
            globalThis.callback(event.data.streamId, event.data.payload);
        }
    });
}

if (globalThis.process) {
    platformBridge = {
        ready: new Promise<void>((res) => res()),
        bridge: {
            get ctx() {
                return globalThis.ctxId;
            },
            Async: (payload: ArrayBuffer) =>
                globalThis.bridges.Async(payload) as Promise<ArrayBuffer>,
            Sync: (payload: ArrayBuffer) => globalThis.bridges.Sync(payload) as ArrayBuffer
        }
    };
} else {
    globalThis.global = globalThis;
    platformBridge = {
        ready: new Promise<void>(async (resolve, reject) => {
            let cwd = "/";
            if (isWorker) {
                await new Promise<void>((workerReady) => {
                    self.onmessage = (message: MessageEvent) => {
                        if (message.data.cwd) {
                            cwd = message.data.cwd;
                            workerReady();
                        }
                    };
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

            await Promise.all([
                // @ts-ignore
                import("fetch"),
                import("timers")
            ]);

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

            // globals process, fetch and buffer
            await import("process");
            process.chdir(cwd);
            await import("buffer");

            resolve();
        })
    };
}

export default platformBridge;
