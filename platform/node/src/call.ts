import os from "node:os";
import path from "node:path";
import fs from "node:fs";
let core: any;

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

    core.callback((id: number) => {
        core.callbackValue(id, callback);
    });
}

export function setDirectories(directories: {
    root: string;
    config: string;
    editor: string;
    tmp: string;
}) {
    core.directories(
        directories.root,
        directories.config,
        directories.editor,
        directories.tmp
    );
}

export function callLib(payload: Uint8Array): Uint8Array {
    return core.call(payload);
}
