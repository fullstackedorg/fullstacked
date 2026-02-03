import { bridge } from "../bridge/index.ts";
import { Git } from "../@types/index.ts";
import {
    Add,
    Branch,
    Checkout,
    Clone,
    Commit,
    GitAuthor,
    GitBranch,
    GitCommit,
    GitStatus,
    GitTag,
    Init,
    Log,
    Merge,
    Pull,
    Push,
    Reset,
    Status,
    Tags
} from "../@types/git.ts";
import type { Duplex } from "../bridge/duplex.ts";

export function init(directory: string, url: string) {
    return bridge(
        {
            mod: Git,
            fn: Init,
            data: [directory, url]
        },
        true
    );
}

export function status(directory: string): GitStatus {
    return bridge(
        {
            mod: Git,
            fn: Status,
            data: [directory]
        },
        true
    );
}

export function add(directory: string, path: string) {
    return bridge(
        {
            mod: Git,
            fn: Add,
            data: [directory, path]
        },
        true
    );
}

export function log(directory: string): GitCommit[] {
    return bridge(
        {
            mod: Git,
            fn: Log,
            data: [directory, 10]
        },
        true
    );
}

export function clone(url: string, directory: string): Duplex {
    return bridge(
        {
            mod: Git,
            fn: Clone,
            data: [url, directory]
        },
        true
    );
}

export function commit(
    directory: string,
    message: string,
    author: GitAuthor
): string {
    return bridge(
        {
            mod: Git,
            fn: Commit,
            data: [directory, message, author]
        },
        true
    );
}

export function pull(directory: string): Duplex {
    return bridge(
        {
            mod: Git,
            fn: Pull,
            data: [directory]
        },
        true
    );
}

export function push(directory: string): Duplex {
    return bridge(
        {
            mod: Git,
            fn: Push,
            data: [directory]
        },
        true
    );
}

export function reset(directory: string, ...files: string[]) {
    return bridge(
        {
            mod: Git,
            fn: Reset,
            data: [directory, ...(files || [])]
        },
        true
    );
}

export function branch(directory: string): GitBranch[] {
    return bridge(
        {
            mod: Git,
            fn: Branch,
            data: [directory]
        },
        true
    );
}

export function tags(directory: string): GitTag[] {
    return bridge(
        {
            mod: Git,
            fn: Tags,
            data: [directory]
        },
        true
    );
}

export function checkout(
    directory: string,
    ref: string,
    create?: boolean,
): Duplex {
    return bridge(
        {
            mod: Git,
            fn: Checkout,
            data: [directory, ref, !!create]
        },
        true
    );
}

export function merge(directory: string, branch: string) {
    return bridge(
        {
            mod: Git,
            fn: Merge,
            data: [directory, branch]
        },
        true
    );
}

export default {
    init,
    status,
    add,
    log,
    clone,
    commit,
    pull,
    push,
    reset,
    branch,
    tags,
    checkout,
    merge
};
