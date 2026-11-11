// A build plugin that works for a while on its thread (400 ms), then says
// where it ran. It runs in a worker: build plugins do by default.
const inWorker = () =>
    typeof (globalThis as any).WorkerGlobalScope !== "undefined";

export default {
    data: { name: "busy", filter: "\\.busy$" },
    callback() {
        const end = Date.now() + 400;
        while (Date.now() < end) {}
        return [
            { outputName: "busy.txt", contents: inWorker() ? "worker" : "page" }
        ];
    }
};
