import { bridge } from "../bridge/index.ts";
import { Git } from "../@types/index.ts";
import {
    Add,
    AuthManager,
    Branch,
    Checkout,
    Clone,
    Commit,
    GitAuth,
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
    Restore,
    Status,
    Tags
} from "../@types/git.ts";
import type { Duplex } from "../bridge/duplex.ts";
import { EventEmitter } from "../bridge/eventEmitter.ts";

export async function createGitAuthManager() {
    return (
        await bridge({
            mod: Git,
            fn: AuthManager,
            data: []
        })
    ).eventEmitter() as EventEmitter<{
        auth: [string];
        authResponse: [string, Partial<GitAuth>];
    }>;
}

export function init(directory: string, url: string) {
    return bridge({
        mod: Git,
        fn: Init,
        data: [directory, url]
    });
}

export function status(directory: string): Promise<GitStatus> {
    return bridge({
        mod: Git,
        fn: Status,
        data: [directory]
    });
}

export function add(directory: string, path: string) {
    return bridge({
        mod: Git,
        fn: Add,
        data: [directory, path]
    });
}

export function log(directory: string): Promise<GitCommit[]> {
    return bridge({
        mod: Git,
        fn: Log,
        data: [directory, 10]
    });
}

export function clone(url: string, directory: string): Promise<Duplex> {
    return bridge({
        mod: Git,
        fn: Clone,
        data: [url, directory]
    });
}

export function commit(
    directory: string,
    message: string,
    author: GitAuthor
): Promise<string> {
    return bridge({
        mod: Git,
        fn: Commit,
        data: [directory, message, author]
    });
}

export function pull(directory: string): Promise<Duplex> {
    return bridge({
        mod: Git,
        fn: Pull,
        data: [directory]
    });
}

export function push(directory: string): Promise<Duplex> {
    return bridge({
        mod: Git,
        fn: Push,
        data: [directory]
    });
}

export function reset(directory: string, hard: boolean, ...files: string[]) {
    return bridge({
        mod: Git,
        fn: Reset,
        data: [directory, hard, ...(files || [])]
    });
}

export async function branch(directory: string): Promise<GitBranch[]> {
    const duplex = (await bridge({
        mod: Git,
        fn: Branch,
        data: [directory]
    })) as Duplex;
    const data = await duplex.promise();
    return JSON.parse(new TextDecoder().decode(data));
}

export async function tags(directory: string): Promise<GitTag[]> {
    const duplex = (await bridge({
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
    create?: boolean
): Promise<Duplex> {
    return bridge({
        mod: Git,
        fn: Checkout,
        data: [directory, ref, !!create]
    });
}

export function merge(directory: string, branch: string) {
    return bridge({
        mod: Git,
        fn: Merge,
        data: [directory, branch]
    });
}

export function restore(directory: string, ...files: string[]) {
    return bridge({
        mod: Git,
        fn: Restore,
        data: [directory, ...(files || [])]
    });
}

export default {
    createGitAuthManager,
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
    merge,
    restore
};
