import { toByteArray } from "../base64.ts";
import type { PlatformBridge } from "./index.ts";

export async function BridgeNodeInit(): Promise<PlatformBridge> {
    const webSocketUrl = new URL(self.location.href);
    webSocketUrl.protocol = webSocketUrl.protocol === "https:" ? "wss:" : "ws:";

    const ctx = await (await globalThis.originalFetch("/ctx")).json();

    const webSocketForCallback = new Promise((res) => {
        const ws = new WebSocket(webSocketUrl);
        ws.binaryType = "arraybuffer";
        ws.onmessage = (e: { data: ArrayBuffer }) => {
            globalThis.callback(
                new DataView(e.data).getUint8(0),
                e.data.slice(1)
            );
        };
        ws.onopen = res;
    });

    await webSocketForCallback;

    return {
        ctx,
        Sync(payload: ArrayBuffer) {
            const xmlHttpRequest = new XMLHttpRequest();
            xmlHttpRequest.open("POST", "/sync", false);
            xmlHttpRequest.send(new Uint8Array(payload));
            const response = xmlHttpRequest.response;
            return toByteArray(response).buffer;
        },
        async Async(payload: ArrayBuffer) {
            const response = await globalThis.originalFetch("/call", {
                method: "POST",
                body: payload
            });
            return response.arrayBuffer();
        }
    };
}
