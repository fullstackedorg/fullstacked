// nodejs source : https://nodejs.org/docs/latest/api/path.html

import { Path } from "../@types/index.ts";
import {
    Join,
    Normalize,
    Parse,
    type ParsedPath,
    Relative,
    Resolve
} from "../@types/path.ts";
import { cwd } from "../process/index.ts";
import os from "../os/index.ts";

export let sep = "/";
let checkRealSep = false;

const constants = {
    get sep() {
        if (!checkRealSep) {
            sep = os.platform() === "win32" ? "\\" : "/";
            checkRealSep = true;
        }
        return sep;
    }
};

function cleanPath(p: string): string {
    if (typeof p !== "string") return p;
    return p.replace(/^[/\\]+(?=[a-zA-Z]:)/, "");
}

export function isAbsolute(path: string) {
    path = cleanPath(path);
    return (
        path.startsWith("/") ||
        path.startsWith("\\") ||
        /^[a-zA-Z]:[/\\]/.test(path)
    );
}

export function resolve(...paths: string[]): string {
    paths = paths.map(cleanPath);
    if (paths[0].startsWith("build:")) {
        return paths.join(constants.sep);
    } else if (!isAbsolute(paths[0])) {
        paths.unshift(cwd());
    }
    return globalThis.fullstacked.bridge(
        {
            mod: Path,
            fn: Resolve,
            data: paths
        },
        true
    );
}

export function join(...paths: string[]): string {
    return globalThis.fullstacked.bridge(
        {
            mod: Path,
            fn: Join,
            data: paths.map(cleanPath)
        },
        true
    );
}

export function normalize(path: string): string {
    return globalThis.fullstacked.bridge(
        {
            mod: Path,
            fn: Normalize,
            data: [cleanPath(path)]
        },
        true
    );
}

export function parse(path: string): ParsedPath {
    return globalThis.fullstacked.bridge(
        {
            mod: Path,
            fn: Parse,
            data: [cleanPath(path)]
        },
        true
    );
}

export function extname(path: string) {
    return parse(path).ext;
}

export function dirname(path: string) {
    const parsed = parse(path);
    if (parsed.dir) return parsed.dir;
    if (parsed.root) return parsed.root;
    return ".";
}

export function basename(path: string, suffix?: string) {
    const base = parse(path).base;
    if (suffix && base.endsWith(suffix)) {
        return base.slice(0, 0 - suffix.length);
    }
    return base;
}

// handled above

export function relative(from: string, to: string) {
    return globalThis.fullstacked.bridge(
        {
            mod: Path,
            fn: Relative,
            data: [cleanPath(from), cleanPath(to)]
        },
        true
    );
}

const mod = {
    get sep() {
        return constants.sep;
    },
    resolve,
    join,
    normalize,
    parse,
    extname,
    dirname,
    basename,
    isAbsolute,
    relative
};

export const posix = mod;
export const win32 = mod;

export default mod;
