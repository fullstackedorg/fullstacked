import "../buffer/index.ts";
import { GoFileInfo } from "../@types/fs";
import { fromByteArray } from "../bridge/base64.ts";

export type PathLike = string | URL | Buffer;

export function formatPathLike(path: PathLike) {
    return path instanceof URL ? path.pathname : path.toString();
}

export type ReadFileOpts = {
    encoding: string;
};

export function decodeStringData(data: Uint8Array, options: ReadFileOpts) {
    if (!options?.encoding) return Buffer.from(data);

    if (options.encoding === "base64") {
        return fromByteArray(data);
    }

    return new TextDecoder(options.encoding).decode(data);
}

export type ReadDirOpts = {
    recursive: boolean;
    withFileTypes: boolean;
};

export interface Stats {
    // dev: 2114,
    // ino: 48064969,
    mode: number;
    // nlink: 1,
    // uid: 85,
    // gid: 100,
    // rdev: 0,
    size: number;
    // blksize: 4096,
    // blocks: 8,
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    // isBlockDevice(): boolean
    // isCharacterDevice(): boolean
    // isFIFO(): boolean
    isDirectory(): boolean;
    isFile(): boolean;
    // isSocket(): boolean
    // isSymbolicLink(): boolean
}

export function fileInfoToStat(fileInfo: GoFileInfo): Stats {
    const typeFlag = fileInfo.IsDir
        ? 16384 // fs.constants.S_IFDIR
        : 32768; // fs.constants.S_IFREG

    const mode = typeFlag | fileInfo.Mode;

    return {
        mode,
        size: fileInfo.Size,
        atimeMs: fileInfo.ATime / 1e6,
        mtimeMs: fileInfo.MTime / 1e6,
        ctimeMs: fileInfo.CTime / 1e6,
        birthtimeMs: fileInfo.BirthTime / 1e6,
        atime: new Date(fileInfo.ATime / 1e6),
        mtime: new Date(fileInfo.MTime / 1e6),
        ctime: new Date(fileInfo.CTime / 1e6),
        birthtime: new Date(fileInfo.BirthTime / 1e6),
        isDirectory: () => fileInfo.IsDir,
        isFile: () => !fileInfo.IsDir
    };
}

export type StatOpts = {
    throwIfNoEntry?: boolean;
};

export interface Dirent {
    name: string;
    parentPath: string;
    // isBlockDevice(): boolean
    // isCharacterDevice(): boolean
    isDirectory(): boolean;
    // isFIFO(): boolean
    isFile(): boolean;
    // isSocket(): boolean
    // isSymbolicLink(): boolean
}

export function convertGoFileInfo(
    baseDir: string,
    items: GoFileInfo[],
    withFileTypes: boolean
): Dirent[] | string[] {
    if (withFileTypes) {
        return items.map((item) => {
            const itemNameComponents = item.Name.split("/");
            const name = itemNameComponents.pop();
            const parentPath = [baseDir, ...itemNameComponents].join("/");
            return {
                name,
                parentPath,
                isDirectory: () => item.IsDir,
                isFile: () => !item.IsDir
            };
        }) as Dirent[];
    }

    return items.map(({ Name }) => Name);
}
