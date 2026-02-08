import { Core } from "../@types/index.ts";
import { Run } from "../@types/router.ts";
import { bridge } from "../bridge/index.ts";

export function run(directory: string): Promise<void> {
    return bridge({
        mod: Core,
        fn: Run,
        data: [directory]
    });
}

export default run;
