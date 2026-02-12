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
                platformBridge.bridge.Async(e.data).then((res) => {
                    this.w.postMessage(new Uint8Array(res));
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
