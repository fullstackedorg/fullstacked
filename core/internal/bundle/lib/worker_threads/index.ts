import "../bridge/platform.ts";
import { cwd } from "../process/index.ts";
import events from "events";
import { deserializeNumber } from "../bridge/serialization.ts";
import { isWorker } from "../bridge/isWorker.ts";
import { acquireId, releaseId } from "../bridge/ids.ts";
import { shared } from "../bridge/shared.ts";
import { Stream } from "../@types/index.ts";
import { Close } from "../@types/stream.ts";

export let parentPort: any = null;

// The sync calls of a worker read their response themselves, with GET
// /sync/{key} when the host reads no body (Android). The worker's ids come
// from its own allocator: the page's sync calls and the other workers' use
// the same ids at the same time, and the worker reads before the page
// relayed its call. Each worker of the page gets its own keys, [n][id]: the
// host keeps the response of a relayed call under its key and nothing else
// there (a worker took the response of the page's last sync call with its id,
// another file's bytes). The keys are the page's (see shared.ts).
const workerSyncKeys = shared("workerSyncKeys", () => {
    let last = 0;
    return {
        next() {
            // 1 to 2^23 - 1, the key fits an int of the host
            last = last === 0x7fffff ? 1 : last + 1;
            return last << 8;
        }
    };
});

if (isWorker) {
    class ParentPortWrapper extends events.EventEmitter {
        constructor() {
            super();
            self.addEventListener("message", (e: MessageEvent) => {
                if (e.data && e.data.type === "on-stream-data") {
                    return;
                }
                this.emit("message", e);
            });
        }
        postMessage(data: any, transfer?: any) {
            self.postMessage(data, transfer);
        }
    }
    parentPort = new ParentPortWrapper();
}

export class Worker extends events.EventEmitter {
    w: globalThis.Worker = null;
    // the key base of this worker's relayed sync calls, 0 when the host
    // reads them by id (see workerSyncKeys)
    syncKeyBase = 0;

    constructor(path: string) {
        super();

        // the key base goes in the name: the worker reads it as it starts
        // (it can miss the first message)
        if (globalThis.fullstacked.platformBridge?.bridge?.RelaySync) {
            this.syncKeyBase = workerSyncKeys.next();
        }
        this.w = new globalThis.Worker(path, {
            type: "module",
            name: this.syncKeyBase
                ? `fullstacked-sync:${this.syncKeyBase}`
                : undefined
        });

        this.postMessage({ cwd: cwd() });

        this.w.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                this.relay(e.data);
            } else if (typeof e.data === "string" && e.data === "exit") {
                this.cleanup();
                this.emit("exit");
            } else {
                this.emit("message", e);
            }
        };

        // like Node, without crashing the page when nothing listens
        this.w.onerror = (e) => {
            if (this.listenerCount("error") === 0) return;
            e.preventDefault();
            this.emit("error", new Error(e.message || "worker error"));
        };
    }

    // relays a bridge call of the worker to the platform bridge
    async relay(buffer: ArrayBuffer) {
        const platformBridge = globalThis.fullstacked.platformBridge.bridge;
        const payload = new Uint8Array(buffer);
        const workerId = payload[1];

        // sync: the worker reads the response itself, with its key
        if (payload[4] === 1) {
            if (this.syncKeyBase && platformBridge.RelaySync) {
                platformBridge.RelaySync(this.syncKeyBase + workerId, buffer);
                return;
            }
            if (platformBridge.Send) {
                platformBridge.Send(buffer);
                return;
            }
        }

        // async: the worker ids are not allocated with the ids of this
        // runtime, use one of ours for the call
        let id = acquireId();
        if (typeof id !== "number") {
            id = await id;
        }
        payload[1] = id;
        let res: ArrayBuffer;
        try {
            res = await platformBridge.Async(buffer);
        } finally {
            releaseId(id);
        }

        const responseView = new DataView(res);
        if (res.byteLength > 0 && responseView.getUint8(0) === 2) {
            const streamId = deserializeNumber(res, 1).data;
            globalThis.fullstacked.workerStreams.set(streamId, this.w);
        }

        const response = new Uint8Array(res.byteLength + 1);
        response[0] = workerId;
        response.set(new Uint8Array(res), 1);
        this.w.postMessage(response.buffer, [response.buffer]);
    }

    // forgets the worker's streams and closes them in the core: nothing
    // reads them anymore (a socket would stay open, a plugin would keep
    // getting calls nobody answers)
    cleanup(): Promise<void> {
        const workerStreams = globalThis.fullstacked.workerStreams;
        const closing: Promise<unknown>[] = [];
        if (workerStreams) {
            for (const [streamId, worker] of workerStreams.entries()) {
                if (worker === this.w) {
                    workerStreams.delete(streamId);
                    closing.push(
                        globalThis.fullstacked
                            .bridge({
                                mod: Stream,
                                fn: Close,
                                data: [streamId]
                            })
                            .catch(() => {})
                    );
                }
            }
        }
        return Promise.all(closing).then(() => {});
    }

    postMessage(data: any) {
        this.w.postMessage(data);
    }

    terminate(): Promise<void> {
        this.w.terminate();
        return this.cleanup();
    }
}
