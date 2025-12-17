import { load } from "../platform/node/src/call.ts";
import { getLocalLibPath } from "../platform/node/src/lib.ts";
import path from "node:path";
import url from "node:url";
import { after } from "node:test";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const nodeDirectory = path.resolve(currentDirectory, "..", "platform", "node");
const libDirectory = path.resolve(currentDirectory, "..", "core", "bin");
const libPath = getLocalLibPath(libDirectory);
if (!libPath) {
    throw new Error("make sure to build core before running node:test");
}
const core = load(libPath, nodeDirectory, (_, id, buffer) => {
    globalThis.callback(id, buffer);
});
const ctxId = core.start(process.cwd());

(globalThis as any).platform = "test";
globalThis.bridges = {
    ctx: ctxId,
    Sync: core.call,
    Async: async (payload: ArrayBuffer) => core.call(payload)
};

// release callback
after(core.end);
