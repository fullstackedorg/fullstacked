import { Packages } from "../@types/index.ts";
import { Install, Progress, Audit, Uninstall } from "../@types/packages.ts";
import { Duplex } from "../bridge/duplex.ts";
import { EventEmitter } from "../bridge/eventEmitter.ts";

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

const packages = {
    install,
    uninstall,
    audit
};

export default packages;
