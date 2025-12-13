import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
globalThis.require = createRequire(import.meta.url);
let core: {
    load(libPath: string): void;
    call(payload: ArrayBuffer): Uint8Array<ArrayBuffer>;
};

export const CoreCallbackListeners = new Set<typeof callback>();
function callback(projectId: string, messageType: string, message: string) {
    CoreCallbackListeners.forEach((cb) => cb(projectId, messageType, message));
}

export function load(libPath: string, bindingDir: string) {
    const bindingFileName = `${os.platform()}-${os.arch()}.node`;
    const p = path.resolve(bindingDir, bindingFileName);
    if (!fs.existsSync(p)) {
        throw `Cannot find core library binding file at ${p}`;
    }
    core = require(p);
    core.load(libPath);

    return core;
}

export function setDirectories(directories: {
    root: string;
    config: string;
    editor: string;
    tmp: string;
}) {
    // core.directories(
    //     directories.root,
    //     directories.config,
    //     directories.editor,
    //     directories.tmp
    // );
}
