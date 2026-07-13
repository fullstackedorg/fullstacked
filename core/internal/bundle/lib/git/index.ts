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
    GitHead,
    GitProxy,
    GitStatus,
    GitTag,
    HasGit,
    Head,
    Init,
    Log,
    Merge,
    Pull,
    Push,
    Reset,
    Restore,
    SetConfig,
    Status,
    Tags
} from "../@types/git.ts";
import type { Duplex } from "../bridge/duplex.ts";

// 2026-06-30: removed
export async function createGitAuthManager() {
    console.warn(
        "[WARNING]: Git auth manager has been removed. Use plugin system."
    );
    return {
        on() {
            console.warn(
                "[WARNING]: Git auth manager has been removed. Use plugin system."
            );
        }
    };
}

export function hasGit(directory: string): Promise<boolean> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: HasGit,
        data: [directory]
    });
}

export function init(directory: string, url: string) {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Init,
        data: [directory, url]
    });
}

export function head(directory: string): Promise<GitHead> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Head,
        data: [directory]
    });
}

export function status(directory: string): Promise<GitStatus> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Status,
        data: [directory]
    });
}

export function add(directory: string, path: string) {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Add,
        data: [directory, path]
    });
}

export function log(directory: string): Promise<GitCommit[]> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Log,
        data: [directory, 10]
    });
}

export function clone(
    url: string,
    directory: string,
    opts?: {
        tunnel?: string;
        proxy?: GitProxy;
    }
): Promise<Duplex> {
    // backward compat, 2026-07-08
    const options = typeof opts === "string" ? { tunnel: opts } : opts;
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Clone,
        data: [url, directory, options?.tunnel, options?.proxy]
    });
}

export function commit(
    directory: string,
    message: string,
    author: GitAuthor
): Promise<string> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Commit,
        data: [directory, message, author]
    });
}

export function pull(directory: string, tunnel?: string): Promise<Duplex> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Pull,
        data: [directory, tunnel]
    });
}

export function push(directory: string, tunnel?: string): Promise<Duplex> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Push,
        data: [directory, tunnel]
    });
}

export function reset(directory: string, hard: boolean, ...files: string[]) {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Reset,
        data: [directory, hard, ...(files || [])]
    });
}

export async function branch(directory: string): Promise<GitBranch[]> {
    const duplex = (await globalThis.fullstacked.bridge({
        mod: Git,
        fn: Branch,
        data: [directory]
    })) as Duplex;
    const data = await duplex.promise();
    return JSON.parse(new TextDecoder().decode(data));
}

export async function tags(directory: string): Promise<GitTag[]> {
    const duplex = (await globalThis.fullstacked.bridge({
        mod: Git,
        fn: Tags,
        data: [directory]
    })) as Duplex;
    const data = await duplex.promise();
    return JSON.parse(new TextDecoder().decode(data));
}

export function checkout(
    directory: string,
    ref: string,
    create?: boolean,
    tunnel?: string
): Promise<Duplex> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Checkout,
        data: [directory, ref, !!create, tunnel || ""]
    });
}

export function merge(directory: string, branch: string) {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Merge,
        data: [directory, branch]
    });
}

export function restore(directory: string, ...files: string[]) {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: Restore,
        data: [directory, ...(files || [])]
    });
}

export function setConfig(
    directory: string,
    key: string,
    value: string
): Promise<void> {
    return globalThis.fullstacked.bridge({
        mod: Git,
        fn: SetConfig,
        data: [directory, key, value]
    });
}

const git = {
    hasGit,
    init,
    head,
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
    merge,
    restore,
    setConfig,
    createGitAuthManager
};

export default git;
