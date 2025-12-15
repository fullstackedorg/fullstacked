// nodejs source : https://nodejs.org/docs/latest/api/path.html

import { bridge } from "../bridge/index.ts";
import { Path } from "../@types/index.ts";
import { Join, Normalize, Parse, ParsedPath, Resolve } from "../@types/path.ts";

export function resolve(...paths: string[]): string {
    return bridge(
        {
            mod: Path,
            fn: Resolve,
            data: paths
        },
        true
    );
}

export function join(...paths: string[]): string {
    return bridge(
        {
            mod: Path,
            fn: Join,
            data: paths
        },
        true
    );
}

export function normalize(path: string): string {
    return bridge(
        {
            mod: Path,
            fn: Normalize,
            data: [path]
        },
        true
    );
}

export function parse(path: string): ParsedPath {
    return bridge(
        {
            mod: Path,
            fn: Parse,
            data: [path]
        },
        true
    );
}

export function extname(path: string) {
    return parse(path).ext;
}
export function dirname(path: string) {
    return parse(path).dir;
}
export function basename(path: string, suffix?: string) {
    const base = parse(path).base;
    if (suffix && base.endsWith(suffix)) {
        return base.slice(0, 0 - suffix.length);
    }
    return base;
}
