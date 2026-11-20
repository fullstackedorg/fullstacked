import { Core } from "../@types/index.ts";
import { Run } from "../@types/router.ts";
import path from "../path/index.ts";

type RunOptions = {
    directory?: string;
    env?: Record<string, string>;
    safe?: boolean;
    /**
     * `"bundle"` (the default) serves the page from `out/`, built by `bundle`.
     * `"transform"` serves it from the project's sources: each module is
     * transformed when the page asks for it, and the npm dependencies are
     * pre-bundled once and cached (call `prepare` from `fullstacked/bundle`
     * first to report errors before the page opens). A project without
     * sources (shipped pre-built) runs in bundle mode either way.
     */
    mode?: "bundle" | "transform";
};

/**
 * Creates a new runtime context for the project in `directory`.
 * Resolves with the context id: pass it to `globalThis.fullstacked.open(ctx)`
 * to display the project.
 */
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
    const mode =
        typeof directoryOrOptions === "object"
            ? directoryOrOptions.mode
            : undefined;

    const resolved = path.resolve(directory ?? ".");

    const newCtx = (await globalThis.fullstacked.bridge({
        mod: Core,
        fn: Run,
        data:
            mode === "transform"
                ? [resolved, env ?? {}, !!safe, mode]
                : [resolved, env, safe]
    })) as number;

    return newCtx;
}

export default run;
