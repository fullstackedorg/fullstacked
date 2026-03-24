import path from "../../path/index.ts";

let currentDir: string = null;

export function cwd() {
    if (currentDir === null) {
        currentDir = path.sep;
    }
    return currentDir;
}

export function setDir(dir: string) {
    currentDir = dir;
}
