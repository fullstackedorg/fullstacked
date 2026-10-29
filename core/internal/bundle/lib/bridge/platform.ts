// The bridge of a page to its host (see improvements/perfs/porting.md). Every host serves
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
import {
    type FrameRing,
    readFrameSharedBuffers,
    readFrameStream
} from "./frames.ts";
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
        callAsync(batchBase64: string): void;
        setOption(name: string, value: string): void;
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
    // stream frames the host hands over in a ring (WebView2)
    frameRing?: FrameRing;
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

// WebView2: a shared buffer mapped in the page and the host (Channel.cs)
// carries the calls, the responses and the stream frames instead of base64
// messages and requests through WebResourceRequested (~2 ms on WebView2
// whatever the handler does).
// - sync calls: the page writes the payload in the sync request slot, posts
//   "#s" and spins on the state of the response slot until the host
//   published the response, one UI thread dispatch, one thread hop, the core
//   call and a memcpy away. Slots: request [u32 state][u32 length][bytes],
//   response [u32 state][u32 length][u32 total][bytes]; a response larger
//   than its slot comes in chunks the page acknowledges.
// - async calls: appended to the request ring, the page posts "#a"; the
//   responses come back in the response ring as [id u8][response] records,
//   the stream frames in the frame ring, both drained on the "R" message
//   the host posts once per UI tick (the base64 replies of the calls that
//   did not fit a ring travel in that message).
// - rings: [u32 head][u32 tail][pad to 64][data], one producer and one
//   consumer, records [u32 length][bytes] never wrap (a length of
//   0xFFFFFFFF, or less than 4 bytes left, means the next record is at 0),
//   a record leaves at least one byte free so head == tail only when empty.
const STATE_FREE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 3;
const STATE_PARTIAL = 4;
const STATE_ACK = 5;
const CHANNEL_TIMEOUT_MS = 3000;
const SYNC_TIMEOUT_MS = 30000;

type SharedLayout = {
    type: "calls";
    syncRequest: number;
    syncRequestCapacity: number;
    syncResponse: number;
    syncResponseCapacity: number;
    requestRing?: number;
    requestRingSize?: number;
    responseRing?: number;
    responseRingSize?: number;
    frameRing?: number;
    frameRingSize?: number;
};

type SharedChannel = {
    // the response, or null when the call did not fit in the slot
    sync: (payload: ArrayBuffer) => ArrayBuffer | null;
    // appends an async call to the request ring, false when it did not fit
    call: (payload: ArrayBuffer) => boolean;
    // the responses and frames the host appended to its rings
    drain: (
        onResponse: (id: number, response: ArrayBuffer) => void,
        onFrames: (bytes: Uint8Array) => void
    ) => void;
};

const RING_HEADER = 64;
const RING_WRAP = 0xffffffff;

class Ring {
    private words: Int32Array;
    private bytes: Uint8Array;
    private view: DataView;
    private size: number;
    // word indexes of head and tail, byte offset of the data
    private head: number;
    private tail: number;
    private data: number;

    constructor(
        words: Int32Array,
        bytes: Uint8Array,
        offset: number,
        size: number
    ) {
        this.words = words;
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer);
        this.size = size;
        this.head = offset >> 2;
        this.tail = (offset + 4) >> 2;
        this.data = offset + RING_HEADER;
    }

    // producer side
    write(payload: Uint8Array): boolean {
        const need = 4 + payload.byteLength;
        const head = Atomics.load(this.words, this.head);
        const tail = Atomics.load(this.words, this.tail);
        let at: number;
        if (tail >= head) {
            if (tail + need < this.size) {
                at = tail;
            } else if (head > need) {
                if (tail + 4 <= this.size) {
                    this.view.setUint32(this.data + tail, RING_WRAP, true);
                }
                at = 0;
            } else {
                return false;
            }
        } else if (tail + need < head) {
            at = tail;
        } else {
            return false;
        }
        this.bytes.set(payload, this.data + at + 4);
        this.view.setUint32(this.data + at, payload.byteLength, true);
        Atomics.store(this.words, this.tail, at + need);
        return true;
    }

    // consumer side, the records are views valid during the callback
    drain(onRecord: (record: Uint8Array) => void) {
        const tail = Atomics.load(this.words, this.tail);
        let head = Atomics.load(this.words, this.head);
        while (head !== tail) {
            if (
                this.size - head < 4 ||
                this.view.getUint32(this.data + head, true) === RING_WRAP
            ) {
                head = 0;
                Atomics.store(this.words, this.head, 0);
                continue;
            }
            const length = this.view.getUint32(this.data + head, true);
            const start = this.data + head + 4;
            onRecord(this.bytes.subarray(start, start + length));
            head += 4 + length;
            Atomics.store(this.words, this.head, head);
        }
    }
}

// asks the host for its calls buffer, null when it has none
function webView2SharedChannel(webview: any): Promise<SharedChannel | null> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            webview.removeEventListener("sharedbufferreceived", onBuffer);
            resolve(null);
        }, CHANNEL_TIMEOUT_MS);
        const onBuffer = (e: any) => {
            if (e.additionalData?.type !== "calls") return;
            clearTimeout(timeout);
            webview.removeEventListener("sharedbufferreceived", onBuffer);
            resolve(sharedChannel(webview, e.getBuffer(), e.additionalData));
        };
        webview.addEventListener("sharedbufferreceived", onBuffer);
        webview.postMessage("#channel");
    });
}

function sharedChannel(
    webview: any,
    buffer: ArrayBuffer,
    layout: SharedLayout
): SharedChannel {
    const bytes = new Uint8Array(buffer);
    // Atomics.load is not hoisted out of the spin loop
    const words = new Int32Array(buffer);
    const requestState = layout.syncRequest >> 2;
    const responseState = layout.syncResponse >> 2;
    const requestData = layout.syncRequest + 8;
    const responseData = layout.syncResponse + 12;
    const ring = (offset: number, size: number) =>
        offset === undefined ? null : new Ring(words, bytes, offset, size);
    const requests = ring(layout.requestRing, layout.requestRingSize);
    const responses = ring(layout.responseRing, layout.responseRingSize);
    const frames = ring(layout.frameRing, layout.frameRingSize);

    const sync = (payload: ArrayBuffer): ArrayBuffer | null => {
        if (payload.byteLength > layout.syncRequestCapacity) return null;
        if (Atomics.load(words, requestState) !== STATE_FREE) return null;
        bytes.set(new Uint8Array(payload), requestData);
        words[requestState + 1] = payload.byteLength;
        Atomics.store(words, requestState, STATE_REQUEST);
        webview.postMessage("#s");
        let result: Uint8Array = null;
        let offset = 0;
        const deadline = performance.now() + SYNC_TIMEOUT_MS;
        let spins = 0;
        while (true) {
            const state = Atomics.load(words, responseState);
            if (state === STATE_RESPONSE || state === STATE_PARTIAL) {
                const length = words[responseState + 1];
                const total = words[responseState + 2];
                if (result === null) result = new Uint8Array(total);
                result.set(
                    bytes.subarray(responseData, responseData + length),
                    offset
                );
                offset += length;
                if (state === STATE_RESPONSE) {
                    Atomics.store(words, responseState, STATE_FREE);
                    return result.buffer as ArrayBuffer;
                }
                Atomics.store(words, responseState, STATE_ACK);
                continue;
            }
            if ((++spins & 1023) === 0 && performance.now() > deadline) {
                throw new Error("sync call timed out on the shared channel");
            }
        }
    };
    const call = (payload: ArrayBuffer) => {
        if (!requests?.write(new Uint8Array(payload))) return false;
        webview.postMessage("#a");
        return true;
    };
    const drain: SharedChannel["drain"] = (onResponse, onFrames) => {
        responses?.drain((record) =>
            onResponse(record[0], record.slice(1).buffer as ArrayBuffer)
        );
        frames?.drain(onFrames);
    };
    return { sync, call, drain };
}

// WebView2: replies batched in one message per UI tick
// "R<id>:<base64>;<id>:<base64>...", sync calls on the shared channel when
// the host posts one
async function webView2Channel(webview: any): Promise<Channel> {
    const shared = await webView2SharedChannel(webview);
    const pending = new Map<number, (response: ArrayBuffer | null) => void>();
    const resolve = (id: number, response: ArrayBuffer | null) => {
        pending.get(id)?.(response);
        pending.delete(id);
    };
    let onFrames: (bytes: Uint8Array) => void = () => {};
    webview.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (typeof data !== "string" || data[0] !== "R") return;
        shared?.drain(resolve, onFrames);
        for (const entry of data.slice(1).split(";")) {
            const separator = entry.indexOf(":");
            if (separator === -1) continue;
            const id = Number(entry.slice(0, separator));
            resolve(id, fromReply(entry.slice(separator + 1)));
        }
    });
    return {
        call: (payload) =>
            new Promise((resolve) => {
                pending.set(new Uint8Array(payload)[1], resolve);
                // the ring, or a base64 message when it is full
                if (!shared?.call(payload)) webview.postMessage(b64(payload));
            }),
        frameRing: shared
            ? {
                  onFrames: (handler) => {
                      onFrames = handler;
                  }
              }
            : undefined,
        // a request through WebResourceRequested costs ~2 ms, even large
        // payloads are faster as messages
        postMinSize: Infinity,
        sync: shared
            ? (payload) => shared.sync(payload) ?? postSync(payload)
            : undefined
    };
}

// Android: the page posts "init" so the host keeps the reply proxy. The
// calls made in the same tick go in one message, [length u32 BE][payload]...,
// through the JavascriptInterface (base64, cheaper per message) or posted as
// an ArrayBuffer when large. The host runs them in order and batches the
// replies the same way, [id u8][length u32 BE][response]..., a length of 0
// when the response went on the frame stream. Sync calls are answered at once.
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
            const replies = new Uint8Array(event.data);
            const view = new DataView(event.data);
            let offset = 0;
            while (offset + 5 <= replies.byteLength) {
                const id = replies[offset];
                const length = view.getUint32(offset + 1);
                offset += 5;
                const response = length
                    ? event.data.slice(offset, offset + length)
                    : null;
                offset += length;
                pending.get(id)?.(response);
                pending.delete(id);
            }
        };
        setTimeout(() => resolve(false), 3000);
    });
    bridge.postMessage("init");
    if (!(await ready)) {
        throw new Error("the host did not answer the bridge init");
    }

    let batch: ArrayBuffer[] = [];
    let batchBytes = 0;
    let flushScheduled = false;
    const flush = () => {
        flushScheduled = false;
        const payloads = batch;
        const bytes = batchBytes;
        batch = [];
        batchBytes = 0;
        const message = new Uint8Array(bytes + 4 * payloads.length);
        const view = new DataView(message.buffer);
        let offset = 0;
        for (const payload of payloads) {
            view.setUint32(offset, payload.byteLength);
            message.set(new Uint8Array(payload), offset + 4);
            offset += 4 + payload.byteLength;
        }
        // "message" posts every batch (to compare the two paths)
        const transport = (globalThis.fullstacked as any).androidTransport;
        if (bytes >= POST_MIN_SIZE || transport === "message") {
            bridge.postMessage(message.buffer);
        } else {
            core.callAsync(b64(message.buffer));
        }
    };
    return {
        call: (payload) =>
            new Promise((resolve) => {
                pending.set(new Uint8Array(payload)[1], resolve);
                batch.push(payload);
                batchBytes += payload.byteLength;
                if (!flushScheduled) {
                    flushScheduled = true;
                    queueMicrotask(flush);
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
    const size = await nativeFetch("/resize").catch((): Response => null);
    if (size?.ok) {
        fullstacked.window.getSize = (): Promise<string> =>
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
        await readFrameSharedBuffers(
            globalThis.chrome.webview,
            channel?.frameRing
        );
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
