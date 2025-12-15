// nodejs source : https://nodejs.org/docs/latest/api/path.html

import { bridge } from "../bridge/index.ts";
import { Path } from "../@types/index.ts";
import { Join, Resolve } from "../@types/path.ts";

export function resolve(...paths: string[]) {
    return bridge(
        {
            mod: Path,
            fn: Resolve,
            data: paths
        },
        true
    );
}

export function join(...paths: string[]) {
    return bridge(
        {
            mod: Path,
            fn: Join,
            data: paths
        },
        true
    );
}

export function normalize() {}
export function extname() {}
export function dirname() {}
export function basename() {}
