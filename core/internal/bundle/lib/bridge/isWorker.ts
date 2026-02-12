export const isWorker =
    typeof globalThis.WorkerGlobalScope !== "undefined" &&
    self instanceof globalThis.WorkerGlobalScope;
