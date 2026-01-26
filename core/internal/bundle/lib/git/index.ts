import { bridge } from "../bridge/index.ts";
import { Git } from "../@types/index.ts";
import { Add,
Log,
Status } from "../@types/git.ts";

export function status(directory?: string) {
    return bridge({
        mod: Git,
        fn: Status,
        data: [directory]
    }, true)
}

export function add(path: string, directory?: string) {
    return bridge({
        mod: Git,
        fn: Add,
        data: [directory, path]
    }, true)
}

export function log(directory?: string){
    return bridge({
        mod: Git,
        fn: Log,
        data: [directory, 10]
    }, true)
}