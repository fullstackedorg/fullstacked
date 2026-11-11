// The same work, in a build plugin that asks for the page
const inWorker = () =>
    typeof (globalThis as any).WorkerGlobalScope !== "undefined";

export default {
    data: { name: "page", filter: "\\.busy$", worker: false },
    callback() {
        const end = Date.now() + 400;
        while (Date.now() < end) {}
        return [
            { outputName: "busy.txt", contents: inWorker() ? "worker" : "page" }
        ];
    }
};
