// The bridge of a page to its host (see perfs/porting.md). Every host serves
// the requests of the page: GET /ctx and /bridge, the static files, POST
// /call and /sync, GET /stream for the stream frames, and the UI endpoints
// /open, /exit and /resize. What a host offers on top is detected here, not
// chosen by a platform name:
// - a message channel for small async calls, cheaper than a request: a
//   WebKit script message handler with reply (Apple, GTK), WebView2 web
//   messages, the Android reply proxy, a QWebChannel object (Qt)
// - the stream frames in shared buffers when the webview cannot stream a
//   response (WebView2)
// - no request bodies (GET /bridge answers "message": Android, Qt < 6.7):
//   every call is a message, sync calls read their response with /sync/{id}
// A host with none of these (Node) gets every call as a request.

import { fromByteArray, toByteArray } from "./base64.ts";
import { isWorker } from "./isWorker.ts";
import { readFrameSharedBuffers, readFrameStream } from "./frames.ts";
import { responseFrame } from "./responses.ts";

export interface PlatformBridge {
    ctx: number;
    Async: (payload: ArrayBuffer) => Promise<ArrayBuffer>;
    Sync: (payload: ArrayBuffer) => ArrayBuffer | void;
    // posts a payload without waiting for its response, the worker relay
    // uses it for the sync calls of workers which read their response
    // themselves
    Send?: (payload: ArrayBuffer) => void;
    GetResponseSync?: (id: number) => ArrayBuffer;
}

declare global {
    var webkit: any;
    var chrome: any;
    var qt: any;
    // the QWebChannel object of Qt (its shim queues the calls made before
    // the channel is up)
    var bridge: any;
    // Android (platform/android Bridge.kt): a JavascriptInterface and a web
    // message listener whose replies carry the responses as [id][response]
    var fullstackedCore: {
        coreCall(payloadBase64: string): string;
        callAsync(payloadBase64: string): void;
    };
    var fullstackedBridge: {
        postMessage(message: ArrayBuffer | string): void;
        onmessage: (event: MessageEvent<ArrayBuffer | string>) => void;
    };
}

// the bridge replaces globalThis.fetch with the core fetch
const nativeFetch = globalThis.fetch.bind(globalThis);

// Qt (6.8) reads a request body past its end unless the host reads exactly
// its size, which it gets from this header (no Content-Length reaches the
// scheme handler). Other hosts ignore it.
const BODY_SIZE_HEADER = "X-Body-Size";

// requests from this size are posted rather than sent as messages
export const POST_MIN_SIZE = 16 << 10;

const b64 = (payload: ArrayBuffer) => fromByteArray(new Uint8Array(payload));
// a reply in base64, empty when the host put the response on the frame stream
const fromReply = (reply: string) => (reply ? toByteArray(reply).buffer : null);

// Binary call path: the payload is the body of POST /call (async) or
// POST /sync (sync XHR) and the response is the core response, no base64
// and no evaluated script. Hosts run the calls of a page in order.

export async function postCall(payload: ArrayBuffer): Promise<ArrayBuffer> {
    const response = await nativeFetch("/call", {
        method: "POST",
        headers: { [BODY_SIZE_HEADER]: String(payload.byteLength) },
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
    xhr.setRequestHeader(BODY_SIZE_HEADER, String(payload.byteLength));
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

// the response of a sync call sent as a message, kept by the host in base64
function readSyncResponse(id: number): ArrayBuffer {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/sync/${id}`, false);
    xhr.send();
    return toByteArray(xhr.responseText).buffer;
}

// GET /bridge answers "binary" when the host reads the request bodies
async function hostReadsBodies(): Promise<boolean> {
    try {
        const response = await nativeFetch("/bridge", { cache: "no-store" });
        return response.ok && (await response.text()) === "binary";
    } catch {
        return false;
    }
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

function relayCall(payload: ArrayBuffer): Promise<ArrayBuffer> {
    const id = new Uint8Array(payload)[1];
    return new Promise<ArrayBuffer>((resolve) => {
        relayed.set(id, resolve);
        // transfer, the payload is not used after
        globalThis.postMessage(payload, { transfer: [payload] });
    });
}

// A message channel of the host
type Channel = {
    // resolves the response, or null when the host put it on the frame stream
    call: (payload: ArrayBuffer) => Promise<ArrayBuffer | null>;
    // requests from this size go to POST /call instead (default POST_MIN_SIZE)
    postMinSize?: number;
    // a sync call answered at once
    sync?: (payload: ArrayBuffer) => ArrayBuffer;
    // posts a payload without waiting for its response
    send?: (payload: ArrayBuffer) => void;
};

async function detectChannel(): Promise<Channel | null> {
    // WebKit: the reply of the script message handler resolves the promise
    const handlers = globalThis.webkit?.messageHandlers;
    if (handlers?.call) {
        return {
            call: async (payload) =>
                fromReply(await handlers.call.postMessage(b64(payload)))
        };
    }
    if (globalThis.chrome?.webview) {
        return webView2Channel(globalThis.chrome.webview);
    }
    if (globalThis.fullstackedBridge && globalThis.fullstackedCore) {
        return androidChannel(
            globalThis.fullstackedBridge,
            globalThis.fullstackedCore
        );
    }
    // Qt: the reply is the return value of the QWebChannel method
    if (globalThis.qt?.webChannelTransport && globalThis.bridge?.postMessage) {
        const bridge = globalThis.bridge;
        return {
            call: (payload) =>
                new Promise((resolve) =>
                    bridge.postMessage(b64(payload), (reply: string) =>
                        resolve(fromReply(reply))
                    )
                ),
            send: (payload) => bridge.postMessage(b64(payload))
        };
    }
    return null;
}

// WebView2: replies batched in one message per UI tick
// "R<id>:<base64>;<id>:<base64>..."
function webView2Channel(webview: any): Channel {
    const pending = new Map<number, (response: ArrayBuffer | null) => void>();
    webview.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (typeof data !== "string" || data[0] !== "R") return;
        for (const entry of data.slice(1).split(";")) {
            const separator = entry.indexOf(":");
            if (separator === -1) continue;
            const id = Number(entry.slice(0, separator));
            pending.get(id)?.(fromReply(entry.slice(separator + 1)));
            pending.delete(id);
        }
    });
    return {
        call: (payload) =>
            new Promise((resolve) => {
                pending.set(new Uint8Array(payload)[1], resolve);
                webview.postMessage(b64(payload));
            }),
        // a request through WebResourceRequested costs ~2 ms, even large
        // payloads are faster as messages
        postMinSize: Infinity
    };
}

// Android: the page posts "init" so the host keeps the reply proxy, small
// calls go through the JavascriptInterface (cheaper than a message), large
// ones are posted as an ArrayBuffer, sync calls are answered at once
async function androidChannel(
    bridge: typeof globalThis.fullstackedBridge,
    core: typeof globalThis.fullstackedCore
): Promise<Channel> {
    const pending = new Map<number, (response: ArrayBuffer | null) => void>();
    const ready = new Promise<boolean>((resolve) => {
        bridge.onmessage = (event) => {
            if (typeof event.data === "string") {
                resolve(event.data === "ready");
                return;
            }
            const id = new Uint8Array(event.data)[0];
            const response = event.data.slice(1);
            pending.get(id)?.(response.byteLength ? response : null);
            pending.delete(id);
        };
        setTimeout(() => resolve(false), 3000);
    });
    bridge.postMessage("init");
    if (!(await ready)) {
        throw new Error("the host did not answer the bridge init");
    }
    return {
        call: (payload) =>
            new Promise((resolve) => {
                pending.set(new Uint8Array(payload)[1], resolve);
                if (payload.byteLength >= POST_MIN_SIZE) {
                    bridge.postMessage(payload);
                } else {
                    core.callAsync(b64(payload));
                }
            }),
        sync: (payload) => toByteArray(core.coreCall(b64(payload))).buffer,
        send: (payload) => {
            core.coreCall(b64(payload));
        }
    };
}

// Small requests pay less on a message channel than on a request, large ones
// move as raw bytes with POST /call. Calls of both sizes can reach the host in
// another order than they were made, like any two calls not awaited in turn.
function hybridCall(channel: Channel, postMinSize: number) {
    return async (payload: ArrayBuffer): Promise<ArrayBuffer> => {
        if (payload.byteLength >= postMinSize) {
            return postCall(payload);
        }
        const id = new Uint8Array(payload)[1];
        const response = await channel.call(payload);
        return response ?? responseFrame(id);
    };
}

// the UI endpoints of the host; a window to resize is a host that answers
// GET /resize
async function installUI() {
    const fullstacked = globalThis.fullstacked;
    fullstacked.open = (ctx: number) => {
        nativeFetch(`/open?ctx=${ctx}`);
    };
    fullstacked.exit = () => {
        nativeFetch("/exit").finally(() => {
            try {
                window.close();
            } catch {}
        });
    };
    const size = await nativeFetch("/resize").catch(() => null);
    if (size?.ok) {
        fullstacked.window.getSize = () =>
            nativeFetch("/resize").then((r) => r.text());
        fullstacked.window.resize = (size: string) => {
            nativeFetch(`/resize?size=${size}`);
        };
    }
    // iOS: the clipboard is a message handler of the host
    const clipboard = globalThis.webkit?.messageHandlers?.clipboard;
    if (clipboard) {
        const pastes = new Map<number, (text: string) => void>();
        const td = new TextDecoder();
        fullstacked.clipboard.respondPaste = (id: number, base64: string) => {
            pastes.get(id)?.(td.decode(toByteArray(base64)));
            pastes.delete(id);
        };
        fullstacked.clipboard.paste = () => {
            const id = Math.floor(Math.random() * 1000000);
            return new Promise<string>((resolve) => {
                pastes.set(id, resolve);
                clipboard.postMessage(id.toString());
            });
        };
        fullstacked.clipboard.copy = (text: string) => {
            clipboard.postMessage({ action: "copy", text });
        };
    }
}

async function init(): Promise<PlatformBridge> {
    if (isWorker) {
        // the first message of the main thread starts the worker
        await new Promise<void>((workerReady) => {
            self.onmessage = () => workerReady();
        });
        self.addEventListener("message", (event: MessageEvent) => {
            if (event.data?.type === "on-stream-data") {
                globalThis.fullstacked.onStreamData(
                    event.data.streamId,
                    event.data.payload
                );
            }
        });
    }

    const ctx = await (await nativeFetch("/ctx")).json();
    const readsBodies = await hostReadsBodies();

    if (isWorker) {
        // async calls go through the main thread, sync calls post their
        // payload (directly, or through the main thread with Send when the
        // host reads no body) and read the response themselves
        return {
            ctx,
            Async: relayCall,
            Sync: readsBodies
                ? postSync
                : (payload) => {
                      const id = new Uint8Array(payload)[1];
                      // transfer, the payload is not used after
                      globalThis.postMessage(payload, { transfer: [payload] });
                      return readSyncResponse(id);
                  }
        };
    }

    const channel = await detectChannel();
    if (!channel && !readsBodies) {
        throw new Error("the host has no message channel and reads no body");
    }

    // stream data as binary frames, workers get theirs through the main thread
    if (globalThis.chrome?.webview) {
        await readFrameSharedBuffers(globalThis.chrome.webview);
    } else {
        await readFrameStream();
    }

    await installUI();

    const postMinSize = readsBodies
        ? (channel?.postMinSize ?? POST_MIN_SIZE)
        : Infinity;
    return {
        ctx,
        Async: channel ? hybridCall(channel, postMinSize) : postCall,
        Sync:
            channel?.sync ??
            (readsBodies
                ? postSync
                : (payload) => {
                      channel.send(payload);
                      return readSyncResponse(new Uint8Array(payload)[1]);
                  }),
        Send: channel?.send
    };
}

let platformBridge: {
    ready: Promise<void>;
    bridge?: PlatformBridge;
} = null;

// nodejs
if (globalThis.process) {
    platformBridge = {
        ready: Promise.resolve(),
        get bridge() {
            return globalThis.bridge;
        }
    };
}
// every other platform (browser)
else {
    globalThis.global = globalThis;
    platformBridge = {
        ready: init().then((bridge) => {
            platformBridge.bridge = bridge;
        })
    };
}

export default platformBridge;
