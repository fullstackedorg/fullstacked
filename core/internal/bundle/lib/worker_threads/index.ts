import "../bridge/platform/index.ts";
import { cwd } from "../process/index.ts";
import events from "events";
import { deserializeNumber } from "../bridge/serialization.ts";
import { isWorker } from "../bridge/isWorker.ts";

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
                const buffer: ArrayBuffer = e.data;
                const dataView = new DataView(buffer);
                const id = dataView.getUint8(1);
                globalThis.fullstacked.platformBridge.bridge.Async(buffer).then((res) => {
                    const responseView = new DataView(res);
                    if (res.byteLength > 0 && responseView.getUint8(0) === 2) {
                        const streamId = deserializeNumber(res, 1).data;
                        globalThis.fullstacked.workerStreams.set(
                            streamId,
                            this.w
                        );
                    }

                    const response = new Uint8Array(res.byteLength + 1);
                    response[0] = id;
                    response.set(new Uint8Array(res), 1);
                    this.w.postMessage(response.buffer);
                });
            } else if (typeof e.data === "string" && e.data === "exit") {
                this.cleanup();
                this.emit("exit");
            } else {
                this.emit("message", e);
            }
        };
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
