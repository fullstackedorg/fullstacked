import { bridge } from "../bridge";
import { serializeArgs } from "../bridge/serialization";
import core_message from "../core_message";
import { Project } from "../../editor/types";

const pullPromises = new Map<
    string,
    ((pullResponse: PullResponse) => void)[]
>();
let addedListener = false;
function setListenerOnce() {
    if (addedListener) return;

    core_message.addListener("git-pull", (message) => {
        const { url, data, finished } = JSON.parse(message);
        if (!finished) return;
        const promises = pullPromises.get(url);
        promises?.forEach((resolve) => resolve(data));
        pullPromises.delete(url);
    });
    addedListener = true;
}

// 81
export function gitAuthResponse(id: number, success: boolean) {
    const payload = new Uint8Array([81, ...serializeArgs([id, success])]);
    bridge(payload);
}

// 70
export function clone(url: string, into: string) {
    const payload = new Uint8Array([70, ...serializeArgs([into, url])]);
    return bridge(payload);
}

// 71
export function head(
    projectId: string
): Promise<{ name: string; hash: string }> {
    const payload = new Uint8Array([71, ...serializeArgs([projectId])]);

    const transformer = ([name, hash]) => {
        return { name, hash };
    };

    return bridge(payload, transformer);
}

export type Status = {
    added: string[];
    deleted: string[];
    modified: string[];
};

// 72
export function status(projectId: string): Promise<Status> {
    const payload = new Uint8Array([72, ...serializeArgs([projectId])]);

    // added: 0, deleted: 1, modified: 2
    const transformer = (s: (string | number)[]) => {
        const status: Status = {
            added: [],
            deleted: [],
            modified: []
        };

        for (let i = 0; i < s.length; i = i + 2) {
            const file = s[i] as string;
            const type = s[i + 1] as number;

            switch (type) {
                case 0:
                    status.added.push(file);
                    break;
                case 1:
                    status.deleted.push(file);
                    break;
                case 2:
                    status.modified.push(file);
                    break;
            }
        }

        return status;
    };

    return bridge(payload, transformer);
}

// 73
export enum PullResponse {
    DID_PULL = "",
    UP_TO_DATE = "already up-to-date",
    REF_NOT_FOUND = "reference not found",
    UNAUTHORIZED = "authentication required",
    UNREACHABLE = "unreacheable"
}
export async function pull(project?: Project): Promise<PullResponse> {
    setListenerOnce();

    const args = project ? serializeArgs([project.id]) : [];

    const payload = new Uint8Array([73, ...args]);

    const url = await remoteUrl(project);
    let p = pullPromises.get(url);
    if (!p) {
        p = [];
        pullPromises.set(url, p);
    }

    return new Promise((resolve) => {
        p.push(resolve);
        bridge(payload);
    });
}

// 74
export function restore(projectId: string, files: string[]): Promise<void> {
    const payload = new Uint8Array([
        74,
        ...serializeArgs([projectId, ...files])
    ]);

    return bridge(payload);
}

// 75
export function checkout(
    project: Project,
    branch: string,
    create: boolean = false
) {
    const payload = new Uint8Array([
        75,
        ...serializeArgs([project.id, branch, create])
    ]);

    return bridge(payload);
}

// 76
export function fetch(project: Project): Promise<void> {
    const payload = new Uint8Array([76, ...serializeArgs([project.id])]);
    return bridge(payload);
}

// 77
export function commit(project: Project, commitMessage: string): Promise<void> {
    const payload = new Uint8Array([
        77,
        ...serializeArgs([
            project.id,
            commitMessage,
            project.gitRepository.name || "",
            project.gitRepository.email || ""
        ])
    ]);

    return bridge(payload);
}

type Branch = {
    name: string;
    remote: boolean;
    local: boolean;
};

// 78
export async function branches(project: Project): Promise<Branch[]> {
    const payload = new Uint8Array([78, ...serializeArgs([project.id])]);

    // [name, isLocal, isRemote, name, isLocal, isRemote, ...]
    const transformer = (branchesArgs: (string | boolean)[]) => {
        const branches: Branch[] = [];

        for (let i = 0; i < branchesArgs.length; i = i + 3) {
            branches.push({
                name: branchesArgs[i] as string,
                remote: branchesArgs[i + 1] as boolean,
                local: branchesArgs[i + 2] as boolean
            });
        }

        return branches;
    };

    return bridge(payload, transformer);
}

// 79
export function push(project: Project) {
    const payload = new Uint8Array([79, ...serializeArgs([project.id])]);
    return bridge(payload);
}

// 80
export function branchDelete(project: Project, branch: string) {
    const payload = new Uint8Array([
        80,
        ...serializeArgs([project.id, branch])
    ]);

    return bridge(payload);
}

// 82
export function hasGit(project?: Project) {
    const args = project ? [project.id] : [];

    const payload = new Uint8Array([82, ...serializeArgs(args)]);

    return bridge(payload, ([hasGit]) => hasGit);
}

// 83
export function remoteUrl(project?: Project) {
    const args = project ? [project.id] : [];

    const payload = new Uint8Array([83, ...serializeArgs(args)]);

    return bridge(payload, ([url]) => url);
}
