import { load } from "../platform/node/src/core.ts";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

let core: Awaited<ReturnType<typeof load>>;

globalThis.bridges = {
    Sync: (payload: ArrayBuffer) => core.call(payload),
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

const callbackListeners = new Set<(id: number, buffer: ArrayBuffer) => void>();

export default {
    callbackListeners,
    get instance() {
        return core;
    },
    start: async () => {
        core = await load((ctx, id, buffer) => {
            if (ctx === 0) {
                // e2e tests
                globalThis.fullstacked.onStreamData(id, buffer);
            } else {
                // integration tests
                callbackListeners.forEach((cb) => cb(id, buffer));
            }
        });
        core.start(process.cwd(), process.cwd());
    }
};
