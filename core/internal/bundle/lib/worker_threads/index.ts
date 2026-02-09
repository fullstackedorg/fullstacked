import { cwd } from "../process/index.ts";
import events from "events";

export class Worker extends events.EventEmitter {
    w: globalThis.Worker = null;

    constructor(path: string) {
        super();

        this.w = new globalThis.Worker(path, {
            type: "module"
        });

        this.w.postMessage({ cwd: cwd() });

        this.w.onmessage = (e) => {
            if (e.data === "exit") {
                this.emit("exit");
            } else {
                this.emit("message", e);
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
