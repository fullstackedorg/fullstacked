import { toByteArray } from "../base64.ts";
import type { PlatformBridge } from "./index.ts";
import { isWorker } from "../isWorker.ts";

export async function BridgeNodeInit(): Promise<PlatformBridge> {
    if (isWorker) {
        const asyncResponsePromises = new Map<
            number,
            (response: ArrayBuffer) => void
        >();

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

        const ctx = await (await globalThis.originalFetch("/ctx")).json();

        return {
            ctx,
            Sync(payload: ArrayBuffer) {
                const xmlHttpRequest = new XMLHttpRequest();
                xmlHttpRequest.open("POST", "/sync", false);
                xmlHttpRequest.send(new Uint8Array(payload));
                if (xmlHttpRequest.status !== 200) {
                    throw new Error(
                        `Sync POST /sync failed with status ${xmlHttpRequest.status}: ${xmlHttpRequest.statusText}`
                    );
                }
                const response = xmlHttpRequest.response;
                return toByteArray(response).buffer;
            },
            async Async(payload: ArrayBuffer) {
                const dataView = new DataView(payload);
                const id = dataView.getUint8(1);
                return new Promise<ArrayBuffer>((resolve) => {
                    asyncResponsePromises.set(id, resolve);
                    globalThis.postMessage(payload);
                });
            }
        };
    }

    const webSocketUrl = new URL(self.location.href);
    webSocketUrl.protocol = webSocketUrl.protocol === "https:" ? "wss:" : "ws:";

    const ctx = await (await globalThis.originalFetch("/ctx")).json();

    let ws: WebSocket;
    const webSocketForCallback = new Promise((res) => {
        ws = new WebSocket(webSocketUrl);
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

    globalThis.exit = function () {
        ws.close();

        if (window.opener || (window.history && window.history.length === 1)) {
            window.close();
        } else {
            window.location.reload();
        }
    };

    return {
        ctx,
        Sync(payload: ArrayBuffer) {
            const xmlHttpRequest = new XMLHttpRequest();
            xmlHttpRequest.open("POST", "/sync", false);
            xmlHttpRequest.send(new Uint8Array(payload));
            if (xmlHttpRequest.status !== 200) {
                throw new Error(
                    `Sync POST /sync failed with status ${xmlHttpRequest.status}: ${xmlHttpRequest.statusText}`
                );
            }
            const response = xmlHttpRequest.response;
            return toByteArray(response).buffer;
        },
        async Async(payload: ArrayBuffer) {
            const response = await globalThis.originalFetch("/call", {
                method: "POST",
                body: payload
            });
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(
                    `fetch /call failed with status ${response.status}: ${text}`
                );
            }
            return response.arrayBuffer();
        }
    };
}
