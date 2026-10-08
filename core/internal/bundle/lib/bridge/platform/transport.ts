// Binary call path: the payload is the body of POST /call (async) or
// POST /sync (sync XHR) and the response is the core response, no base64
// and no evaluated script. Hosts run the calls of a page in order.

import { isWorker } from "../isWorker.ts";

// the bridge replaces globalThis.fetch with the core fetch
const nativeFetch = globalThis.fetch.bind(globalThis);

export async function postCall(payload: ArrayBuffer): Promise<ArrayBuffer> {
    const response = await nativeFetch("/call", {
        method: "POST",
        body: payload,
        cache: "no-store"
    });
    if (!response.ok) {
        throw new Error(`POST /call failed with status ${response.status}`);
    }
    return response.arrayBuffer();
}

export function postSync(payload: ArrayBuffer): ArrayBuffer {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/sync", false);
    // a sync XHR of a page cannot ask for an arraybuffer, x-user-defined
    // maps each byte to one char
    if (isWorker) {
        xhr.responseType = "arraybuffer";
    } else {
        xhr.overrideMimeType("text/plain; charset=x-user-defined");
    }
    xhr.send(new Uint8Array(payload));
    if (xhr.status !== 200) {
        throw new Error(`POST /sync failed with status ${xhr.status}`);
    }
    if (isWorker) {
        return xhr.response;
    }
    const text: string = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i);
    }
    return bytes.buffer;
}

// Async calls of a worker go through the main thread (worker_threads relay)
// which knows the streams they open and hands their frames to the worker.
const relayed = new Map<number, (response: ArrayBuffer) => void>();
if (isWorker) {
    self.addEventListener("message", (event: MessageEvent) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        // [id][response]
        const id = new Uint8Array(event.data)[0];
        relayed.get(id)?.(event.data.slice(1));
        relayed.delete(id);
    });
}

export function relayCall(payload: ArrayBuffer): Promise<ArrayBuffer> {
    const id = new Uint8Array(payload)[1];
    return new Promise<ArrayBuffer>((resolve) => {
        relayed.set(id, resolve);
        // transfer, the payload is not used after
        globalThis.postMessage(payload, { transfer: [payload] });
    });
}

// GET /bridge answers "binary" when the host serves POST /call and /sync
export async function hostSupportsBinaryCalls(): Promise<boolean> {
    try {
        const response = await nativeFetch("/bridge", { cache: "no-store" });
        return response.ok && (await response.text()) === "binary";
    } catch {
        return false;
    }
}
