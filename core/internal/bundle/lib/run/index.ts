import { Core } from "../@types/index.ts";
import { Run } from "../@types/router.ts";
import path from "../path/index.ts";

type RunOptions = {
    directory?: string;
    env?: Record<string, string>;
    safe?: boolean;
};

export async function run(
    directoryOrOptions?: string | RunOptions
): Promise<number> {
    const directory =
        typeof directoryOrOptions === "string"
            ? directoryOrOptions
            : directoryOrOptions?.directory;
    const env =
        typeof directoryOrOptions === "object"
            ? directoryOrOptions.env
            : undefined;
    const safe =
        typeof directoryOrOptions === "object"
            ? directoryOrOptions.safe
            : undefined;

    const resolved = path.resolve(directory ?? ".");

    const newCtx = (await globalThis.fullstacked.bridge({
        mod: Core,
        fn: Run,
        data: [resolved, env, safe]
    })) as number;

    return newCtx;
}

export default run;
