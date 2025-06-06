declare module "fs" {
    export type FileInfo = {
        name: string;
        isDirectory: boolean;
    };
    export type FileStats = {
        name: string;
        size: number;
        modTime: number;
        isDirectory: boolean;
    };

    export function readFile(path: string): Promise<Uint8Array>;
    export function readFile(
        path: string,
        options: {
            encoding: "utf8";
        }
    ): Promise<string>;
    export function writeFile(
        path: string,
        data: string | Uint8Array
    ): Promise<boolean>;
    export function unlink(path: string): Promise<boolean>;
    export function readdir(
        path: string,
        options?: {
            recursive?: boolean;
            withFileTypes?: false;
        }
    ): Promise<string[]>;
    export function readdir(
        path: string,
        options?: {
            recursive?: boolean;
            withFileTypes: true;
        }
    ): Promise<FileInfo[]>;
    export function mkdir(path: string): Promise<boolean>;
    export function rmdir(path: string): Promise<boolean>;
    export function exists(path: string): Promise<{
        isFile: boolean;
    }>;
    export function rename(oldPath: string, newPath: string): Promise<boolean>;
    export function stat(path: string): Promise<FileStats>;

    var fs: {
        readFile(path: string): Promise<Uint8Array>;
        readFile(
            path: string,
            options: {
                encoding: "utf8";
            }
        ): Promise<string>;
        writeFile(path: string, data: string | Uint8Array): Promise<boolean>;
        unlink(path: string): Promise<boolean>;
        readdir(
            path: string,
            options?: {
                recursive?: boolean;
                withFileTypes?: false;
            }
        ): Promise<string[]>;
        readdir(
            path: string,
            options?: {
                recursive?: boolean;
                withFileTypes: true;
            }
        ): Promise<FileInfo[]>;
        mkdir(path: string): Promise<boolean>;
        rmdir(path: string): Promise<boolean>;
        exists(path: string): Promise<{
            isFile: boolean;
        }>;
        rename(oldPath: string, newPath: string): Promise<boolean>;
        stat(path: string): Promise<FileStats>;
    };
    export default fs;
}

type FetchOptions = {
    method: "GET" | "POST" | "PUT" | "DELETE";
    headers: Record<string, string>;
    body: string | Uint8Array;
    timeout: number;
    stream: boolean;
};

type FetchResponse = {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
};

declare module "fetch" {
    export default function core_fetch(
        url: string,
        options?: Partial<FetchOptions>
    ): Promise<FetchResponse & { body: Uint8Array }>;
    export default function core_fetch(
        url: string,
        options?: Partial<FetchOptions> & { encoding: "utf8" }
    ): Promise<FetchResponse & { body: string }>;

    export function core_fetch2(request: Request): Promise<Response>;
    export function core_fetch2(
        url: string | URL,
        options?: RequestInit
    ): Promise<Response>;
}

declare module "platform" {
    export enum Platform {
        NODE = "node",
        APPLE = "apple",
        ANDROID = "android",
        DOCKER = "docker",
        WINDOWS = "windows",
        WASM = "wasm"
    }

    const platform: Platform;
    export default platform;
}

declare module "archive" {
    type FileEntries<T extends string | Uint8Array> = {
        [filePath: string]: {
            isDir: boolean;
            contents: T;
        };
    };

    export function unzip(
        entry: string | Uint8Array
    ): Promise<FileEntries<Uint8Array>>;
    export function unzip(
        entry: string | Uint8Array,
        out: string
    ): Promise<boolean>;

    export function zip(
        entry: FileEntries<string | Uint8Array>
    ): Promise<Uint8Array>;
    export function zip(entry: string): Promise<Uint8Array>;
    export function zip(
        entry: string,
        out: null | undefined,
        skip: string[]
    ): Promise<Uint8Array>;
    export function zip(
        entry: FileEntries<string | Uint8Array> | string,
        out: string,
        skip?: string[]
    ): Promise<boolean>;

    var archive: {
        unzip(entry: string | Uint8Array): Promise<FileEntries<Uint8Array>>;
        unzip(entry: string | Uint8Array, out: string): Promise<boolean>;
        zip(entry: FileEntries<string | Uint8Array>): Promise<Uint8Array>;
        zip(entry: string): Promise<Uint8Array>;
        zip(
            entry: string,
            out: null | undefined,
            skip: string[]
        ): Promise<Uint8Array>;
        zip(
            entry: FileEntries<string | Uint8Array> | string,
            out: string,
            skip?: string[]
        ): Promise<boolean>;
    };
    export default archive;
}

declare module "connect" {
    export type Data = string | number | boolean | Uint8Array;

    type DataChannelCallback = (data: Data[]) => void;

    type DataChannel = {
        send(...args: Data[]): void;
        on(callback: DataChannelCallback): void;
        off(callback: DataChannelCallback): void;
    };

    type DataChannelRawCallback = (data: Uint8Array) => void;

    type DataChannelRaw = {
        send(buffer: Uint8Array): void;
        on(callback: DataChannelRawCallback): void;
        off(callback: DataChannelRawCallback): void;
    };

    export function connect(
        name: string,
        port: number,
        host: string,
        stream: true
    ): Promise<DataChannelRaw>;
    export function connect(
        name: string,
        port: number,
        host?: string,
        stream?: boolean
    ): Promise<DataChannel>;
}
