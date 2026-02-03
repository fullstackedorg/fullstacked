import { Packages } from "../@types/index.ts";
import { Install, Progress, Uninstall } from "../@types/packages.ts";
import { Duplex } from "../bridge/duplex.ts";
import { EventEmitter } from "../bridge/eventEmitter.ts";
import { bridge } from "../bridge/index.ts";

export async function install(directory: string, saveDev: boolean, ...packages: string[]): Promise<EventEmitter<{
    "progress": Progress[]
}>> {
    return (await bridge({
        mod: Packages,
        fn: Install,
        data: [directory, saveDev, ...(packages || [])]
    }) as Duplex).eventEmitter()
}

export async function uninstall(directory: string, ...packages: string[]) {
    return (await bridge({
        mod: Packages,
        fn: Uninstall,
        data: [directory, ...(packages || [])]
    }) as Duplex).eventEmitter()
}

export function security() {

}

export default {
    install,
    uninstall,
    security
}
