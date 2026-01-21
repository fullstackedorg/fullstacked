import { PlatformBridge } from "./index.ts";

export function BridgeAppleInit(): PlatformBridge {
    return {
        ctx: globalThis.ctx,
        async Async(payload) {
            return null;
        },
        Sync(payload) {
            return null;
        }
    };
}
