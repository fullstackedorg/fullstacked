import { bridge } from "../bridge/index.ts";
import { Git } from "../@types/index.ts";
import {
    Add,
    Clone,
    Commit,
    GitCommit,
    GitStatus,
    Log,
    Status
} from "../@types/git.ts";
import type { Duplex } from "../bridge/duplex.ts";

export function status(directory?: string): GitStatus {
    return bridge(
        {
            mod: Git,
            fn: Status,
            data: [directory]
        },
        true
    );
}

export function add(path: string, directory?: string) {
    return bridge(
        {
            mod: Git,
            fn: Add,
            data: [directory, path]
        },
        true
    );
}

export function log(directory?: string): GitCommit[] {
    return bridge(
        {
            mod: Git,
            fn: Log,
            data: [directory, 10]
        },
        true
    );
}

export function clone(url: string, directory?: string): Duplex {
    return bridge(
        {
            mod: Git,
            fn: Clone,
            data: [url, directory]
        },
        true
    );
}

export function commit(message: string, authorName?: string, authorEmail?: string, directory?: string) {
    return bridge(
        {
            mod: Git,
            fn: Commit,
            data: [directory, message, authorName, authorEmail]
        },
        true
    );
}

export default {
    status,
    add,
    log,
    clone
};
