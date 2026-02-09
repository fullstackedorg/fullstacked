import { Core } from "../@types/index.ts";
import { Run } from "../@types/router.ts";
import { bridge } from "../bridge/index.ts";
import path from "../path/index.ts";

export function run(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    return bridge({
        mod: Core,
        fn: Run,
        data: [resolved]
    });
}

export default run;
