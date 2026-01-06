import { toByteArray } from "../base64.ts";

globalThis.originalFetch = fetch;

const ctx = await (await globalThis.originalFetch("/ctx")).json();

const webSockerUrl = new URL(window.location.href);
webSockerUrl.protocol = webSockerUrl.protocol === "https:" ? "wss:" : "ws:";

function webSocketForCallback() {
    return new Promise((res) => {
        const ws = new WebSocket(webSockerUrl);
        ws.binaryType = "arraybuffer";
        ws.onmessage = (e: { data: ArrayBuffer }) => {
            globalThis.callback(
                new DataView(e.data).getUint8(0),
                e.data.slice(1)
            );
        };
        ws.onopen = res;
    });
}
await webSocketForCallback();

function Sync(payload: ArrayBuffer) {
    const xmlHttpRequest = new XMLHttpRequest();
    xmlHttpRequest.open("POST", "/call-sync", false);
    xmlHttpRequest.send(payload);
    return toByteArray(xmlHttpRequest.response).buffer;
}

async function Async(payload: ArrayBuffer) {
    const response = await globalThis.originalFetch("/call", {
        method: "POST",
        body: payload
    });
    return response.arrayBuffer();
}

export default {
    ctx,
    Sync,
    Async
};
