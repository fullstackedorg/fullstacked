// nodejs source: https://nodejs.org/docs/latest/api/fs.html

import { bridge } from "../bridge/index.ts";
import { Exists, ReadFileOpts } from "../@types/fs.ts";
import { Fs } from "../@types/index.ts";

type PathLike = string | URL;

export function existsSync(path: PathLike): boolean {
    const data = path instanceof URL ? path.pathname : path;

    return bridge(
        {
            mod: Fs,
            fn: Exists,
            data: [data]
        },
        true
    );
}

export function readFileSync(path: PathLike, options?: ReadFileOpts) {
    const data = [];
}
