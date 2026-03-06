import path from "node:path";
import fs from "node:fs";
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
                globalThis.callback(id, buffer);
            } else {
                // integration tests
                callbackListeners.forEach((cb) => cb(id, buffer));
            }
        });
        core.start(process.cwd(), process.cwd());
        cleanupBundledFiles();
    }
};

export function cleanupBundledFiles() {
    fs.readdirSync("test", { recursive: true })
        .filter(
            (f: string) =>
                !f.includes("static-file") && f.split("/").pop().startsWith("_")
        )
        .forEach((f: string) => fs.rmSync(path.join("test", f)));
}
