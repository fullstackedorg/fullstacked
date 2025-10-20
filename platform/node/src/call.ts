import os from "node:os";
import path from "node:path";
import fs from "node:fs";
let core: any;

export function load(libPath: string, bindingDir?: string) {
    const bindingFileName = `${os.platform()}-${os.arch()}.node`;
    const p = bindingDir
        ? path.resolve(bindingDir, bindingFileName)
        : `./${bindingFileName}`;
    if(!fs.existsSync(p)) {
        throw `Cannot find core library binding file at ${p}`
    }
    core = require(p);
    core.load(libPath);
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

export function setCallback(
    cb: (projectId: string, messageType: string, message: string) => void
) {
    core.callback((id: number) => {
        core.callbackValue(id, cb);
    });
}

export function callLib(payload: Uint8Array): Uint8Array {
    return core.call(payload);
}
