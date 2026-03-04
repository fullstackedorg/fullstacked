import platformBridge from "../bridge/platform/index.ts";
import { cwd } from "../process/cwd/index.ts";
import events from "events";

export class Worker extends events.EventEmitter {
    w: globalThis.Worker = null;

    constructor(path: string) {
        super();

        this.w = new globalThis.Worker(path, {
            type: "module"
        });

        this.postMessage({ cwd: cwd() });

        this.w.onmessage = (e) => {
            if (e.data === "exit") {
                this.emit("exit");
            } else {
                const buffer: ArrayBuffer = e.data;
                const dataView = new DataView(buffer);
                const id = dataView.getUint8(1);
                platformBridge.bridge.Async(buffer).then((res) => {
                    const response = new Uint8Array(res.byteLength + 1);
                    response[0] = id;
                    response.set(new Uint8Array(res), 1);
                    this.w.postMessage(response.buffer);
                });
            }
        };
    }

    postMessage(data: any) {
        this.w.postMessage(data);
    }

    terminate() {
        this.w.terminate();
    }
}
