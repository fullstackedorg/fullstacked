import { Worker } from "worker_threads";

// The bundle the page imports once its own bundle runs (test/multi-bundle).
// worker_threads loads the platform bridge module of this bundle's lib: it
// must use the page's, not start a second one.

export { checks, flood } from "./checks.ts";

// the bridge this bundle calls
export const bridge = globalThis.fullstacked.bridge;

// a worker of this bundle, its async calls relayed with the ids of the page
export function workerCheck() {
    return new Promise<string>((resolve) => {
        const worker = new Worker("./worker.ts.js" + location.search);
        worker.on("message", (event: MessageEvent) => {
            resolve(event.data?.result ?? "no result");
            worker.terminate();
        });
        worker.on("error", (e: any) => resolve(e?.message ?? String(e)));
    });
}
