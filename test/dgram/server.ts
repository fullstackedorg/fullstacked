import { Worker } from "node:worker_threads";

export function startServer(): Promise<Worker> {
    return new Promise((resolve) => {
        const worker = new Worker("./test/dgram/server-dgram.js");
        worker.on("message", () => resolve(worker));
        worker.on("error", console.log);
    });
}
