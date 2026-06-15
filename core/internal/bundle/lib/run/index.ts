import { Core } from "../@types/index.ts";
import { Run } from "../@types/router.ts";
import { bridge } from "../bridge/index.ts";
import path from "../path/index.ts";

type RunOptions = {
    directory?: string;
    env?: Record<string, string>;
};

export function run(directoryOrOptions?: string | RunOptions): Promise<void> {
    const directory =
        typeof directoryOrOptions === "string"
            ? directoryOrOptions
            : directoryOrOptions?.directory;
    const env =
        typeof directoryOrOptions === "object"
            ? directoryOrOptions.env
            : undefined;

    const resolved = path.resolve(directory ?? ".");

    return bridge({
        mod: Core,
        fn: Run,
        data: [resolved, env]
    });
}

export default run;
