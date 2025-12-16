// nodejs source: https://nodejs.org/docs/latest/api/fs.html

import { bridge } from "../bridge/index.ts";
import { Exists, GoFileInfo, ReadFile, Stats } from "../@types/fs.ts";
import { Fs } from "../@types/index.ts";

type PathLike = string | URL | Buffer;

function formatPathLike(path: PathLike) {
    return path instanceof URL ? path.pathname : path.toString();
}

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

export interface Stats {
    // dev: 2114,
    // ino: 48064969,
    mode: number,
    // nlink: 1,
    // uid: 85,
    // gid: 100,
    // rdev: 0,
    size: number,
    // blksize: 4096,
    // blocks: 8,
    atimeMs: number,
    mtimeMs: number,
    ctimeMs: number,
    birthtimeMs: number,
    atime: Date,
    mtime: Date,
    ctime: Date,
    birthtime: Date;
    // isBlockDevice(): boolean
    // isCharacterDevice(): boolean
    // isFIFO(): boolean
    isDirectory(): boolean
    isFile(): boolean
    // isSocket(): boolean
    // isSymbolicLink(): boolean
}

function fileInfoToStat(fileInfo: GoFileInfo): Stats {
    const typeFlag = fileInfo.IsDir
        ? 16384 // fs.constants.S_IFDIR
        : 32768 // fs.constants.S_IFREG

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
    }
}

type StatOpts = {
    throwIfNoEntry?: boolean
}

export function statSync(path: PathLike, options?: StatOpts): Stats {
    const fileInfo: GoFileInfo = bridge({
        mod: Fs,
        fn: Stats,
        data: [formatPathLike(path)]
    }, true)

    return fileInfoToStat(fileInfo)
}

async function statPromise(path: PathLike, options?: StatOpts): Promise<Stats> {
    const fileInfo: GoFileInfo = await bridge({
        mod: Fs,
        fn: Stats,
        data: [formatPathLike(path)]
    })

    return fileInfoToStat(fileInfo)
}

type StatCallback = (err: Error, stat: Stats) => void;

export function stat(path: PathLike, callback: StatCallback): void
export function stat(path: PathLike, options: object, callback: StatCallback): void
export function stat(path: PathLike, options?: StatCallback | object, callback?: StatCallback): void {
    const cb = typeof options === "function" ? options as StatCallback : callback;
    const opts = typeof options === "function" ? null : options; 
    statPromise(path, opts)
        .then(stats => cb(null, stats))
        .catch(e => cb(e, null));
}

type ReadFileOpts = {
    encoding: string
}

function decodeStringData(data: Uint8Array, options: ReadFileOpts) {
    if (!options?.encoding) return Buffer.from(data);
    return new TextDecoder(options.encoding).decode(data);
}

export function readFileSync(path: PathLike): Buffer<ArrayBuffer>;
export function readFileSync(
    path: PathLike,
    options: ReadFileOpts
): string;
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

async function readFilePromise(path: PathLike): Promise<Buffer<ArrayBuffer>>
async function readFilePromise(path: PathLike, options: ReadFileOpts): Promise<string>
async function readFilePromise(path: PathLike, options?: ReadFileOpts) {
    const data: Uint8Array = await bridge(
        {
            mod: Fs,
            fn: ReadFile,
            data: [formatPathLike(path)]
        });

    return decodeStringData(data, options);
}

export function readFile(path: PathLike, callback: (err: Error, data: Buffer) => void): void
export function readFile(path: PathLike, options: ReadFileOpts, callback: (err: Error, data: string) => void): void
export function readFile(path: PathLike, options: ReadFileOpts | Function, callback?: Function) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? null : options;
    readFilePromise(path, opts)
        .then(data => callback(null, data))
        .then(e => callback(e, null));
}



export const promises = {
    stat: statPromise,
    readFile: readFilePromise
}