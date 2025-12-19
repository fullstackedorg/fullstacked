import { toByteArray } from "../base64.ts";

const ctx = await (await fetch("/ctx")).json();

function Sync(payload: ArrayBuffer) {
    const xmlHttpRequest = new XMLHttpRequest();
    xmlHttpRequest.open("POST", "/call-sync", false);
    xmlHttpRequest.send(payload);
    return toByteArray(xmlHttpRequest.response).buffer;
}

async function Async(payload: ArrayBuffer) {
    const response = await fetch("/call", {
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
