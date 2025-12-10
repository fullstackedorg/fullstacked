import { load } from "../platform/node/src/call.ts";
import { getLocalLibPath } from "../platform/node/src/lib.ts";
import path from "node:path";
import url from "node:url";

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const nodeDirectory = path.resolve(currentDirectory, "..", "platform", "node")
const libDirectory = path.resolve(currentDirectory, "..", "core", "bin")
const libPath = getLocalLibPath(libDirectory);
if(!libPath) {
    throw new Error("make sure to build core before running node:test")
}
load(libPath, nodeDirectory)