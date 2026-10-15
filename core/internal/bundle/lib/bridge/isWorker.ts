// WorkerGlobalScope exists in workers only, lib.dom does not declare it
const WorkerScope = (globalThis as { WorkerGlobalScope?: Function })
    .WorkerGlobalScope;

export const isWorker =
    typeof WorkerScope !== "undefined" && self instanceof WorkerScope;
