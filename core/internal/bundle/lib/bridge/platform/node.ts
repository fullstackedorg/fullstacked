import { toByteArray } from "../base64.ts";

globalThis.global = globalThis;

globalThis.originalFetch = fetch;

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

let ctx = {
    id: null
}

const bridge = {
    get ctx() {return ctx.id},
    ready: new Promise<void>(async res => {
        ctx.id = await (await globalThis.originalFetch("/ctx")).json();
        await webSocketForCallback();
        res();
    }),
    Sync,
    Async
}

export default bridge
