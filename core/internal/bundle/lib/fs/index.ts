// nodejs source: https://nodejs.org/docs/latest/api/fs.html

import {
    Copy,
    CreateReadStream,
    CreateWriteStream,
    Exists,
    type GoFileInfo,
    Mkdir,
    ReadDir,
    ReadFile,
    Rename,
    Rm,
    Stats,
    WriteFile,
    AppendFile
} from "../@types/fs.ts";
import { Fs } from "../@types/index.ts";
import { Readable, Writable } from "stream";
import { Buffer } from "buffer";
import type { Duplex } from "../bridge/duplex.ts";
import {
    convertGoFileInfo,
    decodeStringData,
    type Dirent,
    fileInfoToStat,
    formatPathLike,
    type PathLike,
    type ReadDirOpts,
    type ReadFileOpts,
    type StatOpts,
    type Stats as StatsInterface
} from "./common.ts";
import promises from "./promises.ts";
import { resolve } from "../path/index.ts";
import * as allConstants from "../constants/index.ts";

// fs.constants: the fs part of the constants table (macOS values), for
// packages that test modes and flags (ssh2's SFTP Stats.isDirectory)
const FS_CONSTANTS = [
    "UV_FS_SYMLINK_DIR",
    "UV_FS_SYMLINK_JUNCTION",
    "O_RDONLY",
    "O_WRONLY",
    "O_RDWR",
    "UV_DIRENT_UNKNOWN",
    "UV_DIRENT_FILE",
    "UV_DIRENT_DIR",
    "UV_DIRENT_LINK",
    "UV_DIRENT_FIFO",
    "UV_DIRENT_SOCKET",
    "UV_DIRENT_CHAR",
    "UV_DIRENT_BLOCK",
    "S_IFMT",
    "S_IFREG",
    "S_IFDIR",
    "S_IFCHR",
    "S_IFBLK",
    "S_IFIFO",
    "S_IFLNK",
    "S_IFSOCK",
    "O_CREAT",
    "O_EXCL",
    "UV_FS_O_FILEMAP",
    "UV_FS_O_TEMPORARY",
    "UV_FS_O_SHORT_LIVED",
    "UV_FS_O_SEQUENTIAL",
    "UV_FS_O_RANDOM",
    "O_NOCTTY",
    "O_TRUNC",
    "O_APPEND",
    "O_DIRECTORY",
    "O_NOFOLLOW",
    "O_SYNC",
    "O_DSYNC",
    "O_SYMLINK",
    "O_NONBLOCK",
    "S_IRWXU",
    "S_IRUSR",
    "S_IWUSR",
    "S_IXUSR",
    "S_IRWXG",
    "S_IRGRP",
    "S_IWGRP",
    "S_IXGRP",
    "S_IRWXO",
    "S_IROTH",
    "S_IWOTH",
    "S_IXOTH",
    "F_OK",
    "R_OK",
    "W_OK",
    "X_OK",
    "UV_FS_COPYFILE_EXCL",
    "COPYFILE_EXCL",
    "UV_FS_COPYFILE_FICLONE",
    "COPYFILE_FICLONE",
    "UV_FS_COPYFILE_FICLONE_FORCE",
    "COPYFILE_FICLONE_FORCE"
] as const;

export const constants = Object.freeze(
    Object.fromEntries(
        FS_CONSTANTS.map((name) => [
            name,
            (allConstants as unknown as Record<string, number>)[name]
        ])
    )
) as Record<(typeof FS_CONSTANTS)[number], number>;

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
    globalThis.fullstacked
        .bridge({
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

export function appendFileSync(path: PathLike, data: string | Uint8Array) {
    return globalThis.fullstacked.bridge(
        {
            mod: Fs,
            fn: AppendFile,
            data: [formatPathLike(path), data]
        },
        true
    );
}

export function appendFile(
    path: PathLike,
    data: string | Uint8Array,
    callback: (err: Error) => void
) {
    promises
        .appendFile(path, data)
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

        globalThis.fullstacked
            .bridge({
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

type ReadStreamOptions = {
    encoding?: BufferEncoding | null;
    start?: number;
    end?: number;
    highWaterMark?: number;
    autoClose?: boolean;
    emitClose?: boolean;
    signal?: AbortSignal;
};

// the code Node gives an open error, from the message of the Go error
function systemError(message: string, path: string) {
    const codes: [RegExp, string][] = [
        [/no such file or directory|cannot find/i, "ENOENT"],
        [/permission denied|access is denied/i, "EACCES"],
        [/is a directory/i, "EISDIR"]
    ];
    const code = codes.find(([re]) => re.test(message))?.[1];
    const error = new Error(
        code ? `${code}: ${message}, open '${path}'` : message
    ) as NodeJS.ErrnoException;
    if (code) {
        error.code = code;
        error.syscall = "open";
        error.path = path;
    }
    return error;
}

// A Readable over a stream of the core (Fs CreateReadStream), which reads
// the file in chunks of highWaterMark bytes and ends with the last one.
// The core holds its reading while the page is behind (frames backpressure).
export class ReadStream extends Readable {
    path: string;
    bytesRead = 0;
    pending = true;
    private duplex: Duplex | null = null;

    constructor(path: string, options?: ReadStreamOptions | BufferEncoding) {
        const opts: ReadStreamOptions =
            typeof options === "string"
                ? { encoding: options }
                : (options ?? {});
        const highWaterMark = opts.highWaterMark ?? 64 * 1024;
        super({
            highWaterMark,
            encoding: opts.encoding ?? undefined,
            emitClose: opts.emitClose ?? true,
            autoDestroy: opts.autoClose ?? true,
            signal: opts.signal
        });
        this.path = path;
        const start = opts.start ?? 0;
        const end =
            opts.end === undefined || opts.end === Infinity ? -1 : opts.end;

        (
            globalThis.fullstacked.bridge({
                mod: Fs,
                fn: CreateReadStream,
                data: [path, start, end, highWaterMark]
            }) as Promise<Duplex>
        )
            .then(async (d) => {
                if (this.destroyed) {
                    d.end();
                    return;
                }
                this.duplex = d;
                d.on("data", (data) => {
                    if (this.destroyed) return;
                    // the core sends bytes
                    const chunk = data as Uint8Array;
                    this.bytesRead += chunk.byteLength;
                    this.push(
                        Buffer.from(
                            chunk.buffer,
                            chunk.byteOffset,
                            chunk.byteLength
                        )
                    );
                });
                d.on("close", () => {
                    if (!this.destroyed) this.push(null);
                });
                await d.open();
                this.pending = false;
                this.emit("open");
                this.emit("ready");
            })
            .catch((err: any) => {
                this.destroy(
                    systemError(err?.message ?? String(err), this.path)
                );
            });
    }

    // the core pushes the chunks as they are read
    _read() {}

    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        this.duplex?.end();
        callback(error);
    }
}

export function createReadStream(
    path: PathLike,
    options?: ReadStreamOptions | BufferEncoding
): ReadStream {
    return new ReadStream(formatPathLike(path), options);
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
    appendFileSync,
    appendFile,
    renameSync,
    rename,
    realpathSync,
    cpSync,
    cp,
    createWriteStream,
    createReadStream,
    WriteStream,
    ReadStream,
    constants,
    promises
};
