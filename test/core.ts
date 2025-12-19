import path from "node:path";
import url from "node:url";
import { load } from "../platform/node/src/core.ts";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

let core: Awaited<ReturnType<typeof load>>;

export default {
    get instance() {
        return core;
    },
    start: async () => {
        const currentDirectory = path.dirname(
            url.fileURLToPath(import.meta.url)
        );
        const nodeDirectory = path.resolve(
            currentDirectory,
            "..",
            "platform",
            "node"
        );
        const libDirectory = path.resolve(
            currentDirectory,
            "..",
            "core",
            "bin"
        );
        core = await load(libDirectory, nodeDirectory, (_, id, buffer) => {
            globalThis.callback(id, buffer);
        });
        core.start(process.cwd());
        globalThis.bridges = {
            Sync: (payload: ArrayBuffer) => core.call(payload),
            Async: async (payload: ArrayBuffer) => core.call(payload)
        };
    }
};
