// nodejs source: https://nodejs.org/docs/latest/api/fs.html

import { bridge } from "../bridge/index.ts";
import {
    Exists,
    GoFileInfo,
    Mkdir,
    ReadDir,
    ReadFile,
    Rm,
    Stats,
    WriteFile
} from "../@types/fs.ts";
import { Fs } from "../@types/index.ts";
import {
    convertGoFileInfo,
    decodeStringData,
    Dirent,
    fileInfoToStat,
    formatPathLike,
    PathLike,
    ReadDirOpts,
    ReadFileOpts,
    StatOpts,
    Stats as StatsInterface
} from "./common.ts";
import promises from "./promises.ts";

export function existsSync(path: PathLike): boolean {
    return bridge(
        {
            mod: Fs,
            fn: Exists,
            data: [formatPathLike(path)]
        },
        true
    );
}

export function statSync(path: PathLike, options?: StatOpts): StatsInterface {
    const fileInfo: GoFileInfo = bridge(
        {
            mod: Fs,
            fn: Stats,
            data: [formatPathLike(path)]
        },
        true
    );

    return fileInfoToStat(fileInfo);
}

type StatCallback = (err: Error, stat: StatsInterface) => void;

export function stat(path: PathLike, callback: StatCallback): void;
export function stat(
    path: PathLike,
    options: object,
    callback: StatCallback
): void;
export function stat(
    path: PathLike,
    options?: StatCallback | object,
    callback?: StatCallback
): void {
    const cb =
        typeof options === "function" ? (options as StatCallback) : callback;
    const opts = typeof options === "function" ? null : options;
    promises
        .stat(path, opts)
        .then((stats) => cb(null, stats))
        .catch((e) => cb(e, null));
}

export function readFileSync(path: PathLike): Buffer<ArrayBuffer>;
export function readFileSync(path: PathLike, options: ReadFileOpts): string;
export function readFileSync(path: PathLike, options?: ReadFileOpts) {
    const data: Uint8Array = bridge(
        {
            mod: Fs,
            fn: ReadFile,
            data: [formatPathLike(path)]
        },
        true
    );

    return decodeStringData(data, options);
}

export function readFile(
    path: PathLike,
    callback: (err: Error, data: Buffer) => void
): void;
export function readFile(
    path: PathLike,
    options: ReadFileOpts,
    callback: (err: Error, data: string) => void
): void;
export function readFile(
    path: PathLike,
    options: ReadFileOpts | Function,
    callback?: Function
) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? null : options;
    promises
        .readFile(path, opts)
        .then((data) => cb(null, data))
        .catch((e) => cb(e, null));
}

export function readdirSync(
    path: PathLike,
    options: { withFileTypes: true; recursive?: boolean }
): Dirent[];
export function readdirSync(
    path: PathLike,
    options?: { withFileTypes?: false; recursive?: boolean }
): string[];
export function readdirSync(
    path: PathLike,
    options?: Partial<ReadDirOpts>
): string[] | Dirent[] {
    const baseDir = formatPathLike(path);
    const items: GoFileInfo[] = bridge(
        {
            mod: Fs,
            fn: ReadDir,
            data: [baseDir, options?.recursive ?? false]
        },
        true
    );

    return convertGoFileInfo(baseDir, items, options?.withFileTypes);
}

type ReaddirCallback = (err: Error, items: string[]) => void;
type ReaddirWithFileTypesCallback = (err: Error, items: Dirent[]) => void;

export function readdir(path: PathLike, callback: ReaddirCallback): void;
export function readdir(
    path: PathLike,
    options: { withFileTypes: true; recursive?: boolean },
    callback: ReaddirWithFileTypesCallback
): void;
export function readdir(
    path: PathLike,
    options: { withFileTypes?: false; recursive?: boolean },
    callback: ReaddirCallback
): void;
export function readdir(
    path: PathLike,
    options: Partial<ReadDirOpts> | ReaddirCallback,
    callback?: ReaddirCallback | ReaddirWithFileTypesCallback
): void {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options;
    const baseDir = formatPathLike(path);
    bridge({
        mod: Fs,
        fn: ReadDir,
        data: [baseDir, opts?.recursive ?? false]
    })
        .then((items: GoFileInfo[]) =>
            cb(
                null,
                convertGoFileInfo(baseDir, items, opts.withFileTypes) as any[]
            )
        )
        .catch((e) => cb(e, null));
}

export function mkdirSync(path: PathLike) {
    return bridge(
        {
            mod: Fs,
            fn: Mkdir,
            data: [formatPathLike(path)]
        },
        true
    );
}

export async function mkdir(path: PathLike, callback: (err: Error) => void) {
    const err = await bridge({
        mod: Fs,
        fn: Mkdir,
        data: [formatPathLike(path)]
    });
    callback(err);
}

export function rmSync(path: PathLike) {
    return bridge(
        {
            mod: Fs,
            fn: Rm,
            data: [formatPathLike(path)]
        },
        true
    );
}

export async function rm(path: PathLike, callback: (err: Error) => void) {
    const err = await bridge({
        mod: Fs,
        fn: Rm,
        data: [formatPathLike(path)]
    });
    callback(err);
}

export function unlinkSync(path: PathLike) {
    return bridge(
        {
            mod: Fs,
            fn: Rm,
            data: [formatPathLike(path)]
        },
        true
    );
}

export async function unlink(path: PathLike, callback: (err: Error) => void) {
    const err = await bridge({
        mod: Fs,
        fn: Rm,
        data: [formatPathLike(path)]
    });
    callback(err);
}

export function writeFileSync(path: PathLike, data: string | Uint8Array) {
    return bridge(
        {
            mod: Fs,
            fn: WriteFile,
            data: [formatPathLike(path), data]
        },
        true
    );
}

export function writeFile(
    path: PathLike,
    data: string | Uint8Array,
    callback: (err: Error) => void
) {
    bridge({
        mod: Fs,
        fn: WriteFile,
        data: [formatPathLike(path), data]
    })
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export type { Stats, Dirent } from "./common.ts";

export * as promises from "./promises.ts";

export default {
    existsSync,
    statSync,
    stat,
    readFileSync,
    readFile,
    readdirSync,
    readdir,
    mkdirSync,
    mkdir,
    rmSync,
    rm,
    unlinkSync,
    unlink,
    writeFileSync,
    writeFile,

    promises
};
