export function Sync(payload: ArrayBuffer) {
    const xmlHttpRequest = new XMLHttpRequest();
    xmlHttpRequest.open("POST", "/call", true);
    xmlHttpRequest.send(payload);
    return xmlHttpRequest.response as ArrayBuffer;
}

export async function Async(payload: ArrayBuffer) {
    const response = await fetch("/call", {
        method: "POST",
        body: payload
    });
    return response.arrayBuffer();
}
