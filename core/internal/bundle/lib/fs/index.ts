// nodejs source: https://nodejs.org/docs/latest/api/fs.html

import {
    Copy,
    CreateWriteStream,
    Exists,
    GoFileInfo,
    Mkdir,
    ReadDir,
    ReadFile,
    Rename,
    Rm,
    Stats,
    WriteFile
} from "../@types/fs.ts";
import { Fs } from "../@types/index.ts";
import { Writable } from "stream";
import { Duplex } from "../bridge/duplex.ts";
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
import { resolve } from "../path/index.ts";

export function existsSync(path: PathLike): boolean {
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: Exists,
            data: [formatPathLike(path)]
        },
        true
    );
}

export function statSync(path: PathLike, options?: StatOpts): StatsInterface {
    const fileInfo: GoFileInfo = globalThis.fullstacked.bridge(
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
        .stat(formatPathLike(path), opts)
        .then((stats) => cb(null, stats))
        .catch((e) => cb(e, null));
}

export function readFileSync(path: PathLike): Buffer<ArrayBuffer>;
export function readFileSync(path: PathLike, options: ReadFileOpts): string;
export function readFileSync(path: PathLike, options?: ReadFileOpts) {
    const data: Uint8Array = globalThis.fullstacked.bridge(
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
        .readFile(formatPathLike(path), opts)
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
    const items: GoFileInfo[] = globalThis.fullstacked.bridge(
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
    globalThis.fullstacked.bridge({
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
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: Mkdir,
            data: [formatPathLike(path)]
        },
        true
    );
}

export async function mkdir(path: PathLike, callback: (err: Error) => void) {
    promises
        .mkdir(path)
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export function rmSync(path: PathLike) {
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: Rm,
            data: [formatPathLike(path)]
        },
        true
    );
}

export async function rm(path: PathLike, callback: (err: Error) => void) {
    promises
        .rm(path)
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export function unlinkSync(path: PathLike) {
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: Rm,
            data: [formatPathLike(path)]
        },
        true
    );
}

export async function unlink(path: PathLike, callback: (err: Error) => void) {
    promises
        .unlink(path)
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export function writeFileSync(path: PathLike, data: string | Uint8Array) {
    return globalThis.fullstacked.bridge(
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
    promises
        .writeFile(path, data)
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export function renameSync(path: PathLike, path2: PathLike) {
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: Rename,
            data: [formatPathLike(path), formatPathLike(path2)]
        },
        true
    );
}

export function rename(
    path: PathLike,
    path2: PathLike,
    callback: (err: Error) => void
) {
    promises
        .rename(path, path2)
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export function realpathSync(path: PathLike) {
    return resolve(formatPathLike(path));
}

export function cpSync(src: PathLike, dst: PathLike) {
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: Copy,
            data: [formatPathLike(src), formatPathLike(dst)]
        },
        true
    );
}

export function cp(
    src: PathLike,
    dst: PathLike,
    callback: (err: Error) => void
) {
    promises
        .cp(src, dst)
        .then(() => callback(null))
        .catch((e) => callback(e));
}

export class WriteStream extends Writable {
    private duplex: Duplex | null = null;
    private eventEmitter: any = null;

    constructor(path: string, options?: any) {
        super(options);

        globalThis.fullstacked.bridge({
            mod: Fs,
            fn: CreateWriteStream,
            data: [formatPathLike(path)]
        })
            .then((d) => {
                this.duplex = d;
                this.eventEmitter = d.eventEmitter();
                this.eventEmitter.on("error", (err: string) => {
                    this.emit("error", new Error(err));
                });
                this.duplex.on("close", () => {
                    if (!this.destroyed && !this.closed) {
                        this.destroy();
                    }
                });
                this.emit("open");
                this.emit("ready");
            })
            .catch((err) => {
                this.emit("error", err);
            });
    }

    _write(
        chunk: any,
        encoding: string,
        callback: (error?: Error | null) => void
    ) {
        if (!this.duplex) {
            this.once("open", () => this._write(chunk, encoding, callback));
            return;
        }

        this.duplex
            .write(chunk)
            .then(() => callback())
            .catch(callback);
    }

    _final(callback: (error?: Error | null) => void) {
        if (this.duplex) {
            this.duplex
                .end()
                .then(() => callback())
                .catch(callback);
        } else {
            callback();
        }
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        if (this.duplex) {
            this.duplex
                .end()
                .then(() => callback(error))
                .catch((err: any) => callback(err || error));
        } else {
            callback(error);
        }
    }
}

export function createWriteStream(path: PathLike, options?: any): WriteStream {
    return new WriteStream(formatPathLike(path), options);
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
    renameSync,
    rename,
    realpathSync,
    cpSync,
    cp,
    createWriteStream,
    promises
};
