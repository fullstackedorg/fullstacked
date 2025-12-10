export function Sync(payload: ArrayBuffer) {
    const xmlHttpRequest = new XMLHttpRequest();
    xmlHttpRequest.open("POST", "/bridge", true);
    xmlHttpRequest.send(payload);
    return xmlHttpRequest.response as ArrayBuffer;
}

export async function Async(payload: ArrayBuffer) {
    const response = await fetch("/bridge", {
        method: "POST",
        body: payload
    });
    return response.arrayBuffer();
}
