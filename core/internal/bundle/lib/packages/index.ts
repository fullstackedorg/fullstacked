import { Packages } from "../@types/index.ts";
import {
    Install,
    type Progress,
    Audit,
    Uninstall,
    ResolvePackages,
    AddResolveNodePath
} from "../@types/packages.ts";
import type { Duplex } from "../bridge/duplex.ts";
import type { EventEmitter } from "../bridge/eventEmitter.ts";

export async function install(
    directory: string,
    saveDev: boolean,
    ...packages: string[]
): Promise<
    EventEmitter<{
        progress: Progress[];
    }>
> {
    return (
        (await globalThis.fullstacked.bridge({
            mod: Packages,
            fn: Install,
            data: [directory, saveDev, ...(packages || [])]
        })) as Duplex
    ).eventEmitter();
}

export async function uninstall(directory: string, ...packages: string[]) {
    return (
        (await globalThis.fullstacked.bridge({
            mod: Packages,
            fn: Uninstall,
            data: [directory, ...(packages || [])]
        })) as Duplex
    ).eventEmitter();
}

export function audit(directory: string) {
    return globalThis.fullstacked.bridge({
        mod: Packages,
        fn: Audit,
        data: [directory]
    });
}

export function resolve(
    moduleName: string,
    startDir?: string
): Promise<string> {
    return globalThis.fullstacked.bridge({
        mod: Packages,
        fn: ResolvePackages,
        data: [moduleName, startDir ?? ""]
    });
}

export function addNodePath(inputPath: string): Promise<void> {
    return globalThis.fullstacked.bridge({
        mod: Packages,
        fn: AddResolveNodePath,
        data: [inputPath]
    });
}

const packages = {
    install,
    uninstall,
    audit,
    resolve,
    addNodePath
};

export default packages;
