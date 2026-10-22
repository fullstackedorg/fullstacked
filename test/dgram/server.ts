import { Worker } from "node:worker_threads";

export function startServer(): Promise<Worker> {
    return new Promise((resolve, reject) => {
        const worker = new Worker("./test/dgram/server-dgram.js");
        worker.on("message", () => resolve(worker));
        // the port taken (another run still up) fails here, not later
        worker.on("error", reject);
    });
}
