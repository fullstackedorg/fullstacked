import { bridge } from "../bridge";
import { serializeArgs } from "../bridge/serialization";

type FileEntries<T extends string | Uint8Array> = {
    [filePath: string]: {
        isDir: boolean;
        contents: T;
    };
};

function unzipDataToFileEntries(data: any[]): FileEntries<Uint8Array> {
    const entries: FileEntries<Uint8Array> = {};
    for (let i = 0; i < data.length; i = i + 3) {
        entries[data[i]] = {
            isDir: data[i + 1],
            contents: data[i + 2]
        };
    }
    return entries;
}

export function unzip(
    entry: string | Uint8Array
): Promise<FileEntries<Uint8Array>>;
export function unzip(
    entry: string | Uint8Array,
    out: string
): Promise<boolean>;
export function unzip(entry: string | Uint8Array, out?: string) {
    let method: number;
    let args: any[];
    let transformer: (args: any) => any;

    // BIN_TO
    if (entry instanceof Uint8Array) {
        // _FILE => 30
        if (typeof out === "string") {
            method = 30;
            args = [entry, out];
            transformer = ([success]) => success;
        }
        // _BIN => 31
        else {
            method = 31;
            args = [entry];
            transformer = (unzipData) => unzipDataToFileEntries(unzipData);
        }
    }
    // FILE_TO
    else {
        // _FILE => 32
        if (typeof out === "string") {
            method = 32;
            args = [entry, out];
            transformer = ([success]) => success;
        }
        // _BIN => 33
        else {
            method = 33;
            args = [entry];
            transformer = (unzipData) => unzipDataToFileEntries(unzipData);
        }
    }

    const payload = new Uint8Array([method, ...serializeArgs(args)]);
    return bridge(payload, transformer);
}

const te = new TextEncoder();

function fileEntriesToZipData(
    entries: FileEntries<string | Uint8Array>
): any[] {
    return Object.entries(entries)
        .map(([name, { isDir, contents }]) => [
            name,
            isDir,
            contents instanceof Uint8Array ? contents : te.encode(contents)
        ])
        .flat();
}

export function zip(
    entry: FileEntries<string | Uint8Array>
): Promise<Uint8Array>;
export function zip(
    entry: string,
    out?: null | undefined,
    skip?: string[]
): Promise<Uint8Array>;
export function zip(
    entry: FileEntries<string | Uint8Array> | string,
    out: string,
    skip?: string[]
): Promise<boolean>;
export function zip(
    entry: FileEntries<string | Uint8Array> | string,
    out?: string,
    skip?: string[]
) {
    let method: number;
    let args: any[];
    let transformer: (args: any) => any;

    // BIN_TO
    if (typeof entry === "object") {
        // _FILE => 34
        if (typeof out === "string") {
            method = 34;
            args = fileEntriesToZipData(entry);
            args.unshift(out);
            transformer = ([success]) => success;
        }
        // _BIN => 35
        else {
            method = 35;
            args = fileEntriesToZipData(entry);
            transformer = ([zipData]) => zipData;
        }
    }
    // FILE_TO
    else {
        // _FILE => 36
        if (typeof out === "string") {
            method = 36;
            args = [entry, out, ...(skip || [])];
            transformer = ([success]) => success;
        }
        // _BIN => 37
        else {
            method = 37;
            args = [entry, ...(skip || [])];
            transformer = ([zipData]) => zipData;
        }
    }

    const payload = new Uint8Array([method, ...serializeArgs(args)]);

    return bridge(payload, transformer);
}
