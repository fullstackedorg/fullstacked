let currentDir = "/";

export function cwd() {
    return currentDir;
}

export function setDir(dir: string) {
    currentDir = dir;
}
