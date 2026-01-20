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
import { GoFileInfo, ReadDir, ReadFile, Stats } from "../@types/fs.ts";
import { bridge } from "../bridge/index.ts";
import { Fs } from "../@types/index.ts";

export async function readFile(path: PathLike): Promise<Buffer<ArrayBuffer>>;
export async function readFile(
    path: PathLike,
    options: ReadFileOpts
): Promise<string>;
export async function readFile(path: PathLike, options?: ReadFileOpts) {
    const data: Uint8Array = await bridge({
        mod: Fs,
        fn: ReadFile,
        data: [formatPathLike(path)]
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
        data: [baseDir, options?.recursive ?? false]
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
        data: [formatPathLike(path)]
    });

    return fileInfoToStat(fileInfo);
}

export default {
    stat,
    readFile,
    readdir
};
