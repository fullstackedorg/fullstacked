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
import {
    GoFileInfo,
    ReadDir,
    ReadFile,
    Stats,
    Mkdir,
    Rm,
    WriteFile
} from "../@types/fs.ts";
import { bridge } from "../bridge/index.ts";
import { Fs } from "../@types/index.ts";
import { resolve } from "../path/index.ts";

export async function readFile(path: PathLike): Promise<Buffer<ArrayBuffer>>;
export async function readFile(
    path: PathLike,
    options: ReadFileOpts
): Promise<string>;
export async function readFile(path: PathLike, options?: ReadFileOpts) {
    const data: Uint8Array = await bridge({
        mod: Fs,
        fn: ReadFile,
        data: [resolve(formatPathLike(path))]
    });

    return decodeStringData(data, options);
}

export async function readdir(
    path: PathLike,
    options: { withFileTypes: true; recursive?: boolean }
): Promise<Dirent[]>;
export async function readdir(
    path: PathLike,
    options?: { withFileTypes?: false; recursive?: boolean }
): Promise<string[]>;
export async function readdir(
    path: PathLike,
    options?: Partial<ReadDirOpts>
): Promise<string[] | Dirent[]> {
    const baseDir = formatPathLike(path);
    const items: GoFileInfo[] = await bridge({
        mod: Fs,
        fn: ReadDir,
        data: [resolve(baseDir), options?.recursive ?? false]
    });
    return convertGoFileInfo(baseDir, items, options?.withFileTypes);
}

export async function stat(
    path: PathLike,
    options?: StatOpts
): Promise<StatsInterface> {
    const fileInfo: GoFileInfo = await bridge({
        mod: Fs,
        fn: Stats,
        data: [resolve(formatPathLike(path))]
    });

    return fileInfoToStat(fileInfo);
}

export function writeFile(path: PathLike, data: string | Uint8Array) {
    const resolved = resolve(formatPathLike(path));
    console.log(resolved);
    return bridge({
        mod: Fs,
        fn: WriteFile,
        data: [resolved, data]
    });
}

export function mkdir(path: PathLike) {
    return bridge({
        mod: Fs,
        fn: Mkdir,
        data: [resolve(formatPathLike(path))]
    });
}

export function rm(path: PathLike) {
    return bridge({
        mod: Fs,
        fn: Rm,
        data: [resolve(formatPathLike(path))]
    });
}

export function unlink(path: PathLike) {
    return bridge({
        mod: Fs,
        fn: Rm,
        data: [resolve(formatPathLike(path))]
    });
}

export default {
    stat,
    readFile,
    readdir,
    mkdir,
    rm,
    unlink,
    writeFile
};
