import "../bridge/platform/index.ts";
import { cwd } from "../process/index.ts";
import events from "events";
import { deserializeNumber } from "../bridge/serialization.ts";
import { isWorker } from "../bridge/isWorker.ts";
import { acquireId, releaseId } from "../bridge/ids.ts";

export let parentPort: any = null;

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

    constructor(path: string) {
        super();

        this.w = new globalThis.Worker(path, {
            type: "module"
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
    }

    // relays a bridge call of the worker to the platform bridge
    async relay(buffer: ArrayBuffer) {
        const platformBridge = globalThis.fullstacked.platformBridge.bridge;
        const payload = new Uint8Array(buffer);
        const workerId = payload[1];

        // sync: the worker reads the response itself with its own id
        if (payload[4] === 1 && platformBridge.Send) {
            platformBridge.Send(buffer);
            return;
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

    cleanup() {
        const workerStreams = globalThis.fullstacked.workerStreams;
        if (workerStreams) {
            for (const [streamId, worker] of workerStreams.entries()) {
                if (worker === this.w) {
                    workerStreams.delete(streamId);
                }
            }
        }
    }

    postMessage(data: any) {
        this.w.postMessage(data);
    }

    terminate() {
        this.cleanup();
        this.w.terminate();
    }
}
