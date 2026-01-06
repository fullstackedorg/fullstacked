import { Worker } from "node:worker_threads";

export function startServer() {
    return new Promise<Worker>((res) => {
        const worker = new Worker("./test/net/server-net.js");
        worker.on("message", () => res(worker));
        worker.on("error", console.log);
    });
}
