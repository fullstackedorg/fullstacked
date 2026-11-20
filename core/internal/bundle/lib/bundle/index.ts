import { Bundle } from "../@types/index.ts";
import {
    EsbuildVersion,
    type EsbuildResult,
    BundleDir,
    BundleFile,
    PrepareTransform
} from "../@types/bundle.ts";
import path from "../path/index.ts";
import type { Duplex } from "../bridge/duplex.ts";

export function esbuildVersion(): Promise<string> {
    return globalThis.fullstacked.bridge({
        mod: Bundle,
        fn: EsbuildVersion
    });
}

export type BundleOptions = {
    /**
     * Production bundle (`fullstacked --build`): `process.env.NODE_ENV` is
     * `"production"`, so React and React DOM take their production build, and the
     * output is minified.
     */
    production?: boolean;
};

export function bundle(
    entryPoint?: string,
    opts?: BundleOptions
): Promise<EsbuildResult> {
    const resolved = path.resolve(entryPoint ?? ".");
    return new Promise(async (resolve) => {
        const ee = (
            (await globalThis.fullstacked.bridge({
                mod: Bundle,
                fn: BundleDir,
                data: [resolved, !!opts?.production]
            })) as Duplex
        ).eventEmitter() as any;

        ee.on("result", resolve);
    });
}

/**
 * Prepares a project to run in transform mode (`run({ mode: "transform" })`):
 * scans it from its entry point, pre-bundles its npm dependencies (cached in
 * `node_modules/.fullstacked/deps`), runs the build plugins and transforms its
 * modules. Nothing is written to `out/`. Resolves with the errors and warnings
 * a bundle would report.
 */
export function prepare(entryPoint?: string): Promise<EsbuildResult> {
    const resolved = path.resolve(entryPoint ?? ".");
    return new Promise(async (resolve) => {
        const ee = (
            (await globalThis.fullstacked.bridge({
                mod: Bundle,
                fn: PrepareTransform,
                data: [resolved]
            })) as Duplex
        ).eventEmitter() as any;

        ee.on("result", resolve);
    });
}

export function bundleFile(entryPoint: string): Promise<EsbuildResult> {
    const resolved = path.resolve(entryPoint);

    return globalThis.fullstacked.bridge({
        mod: Bundle,
        fn: BundleFile,
        data: [resolved]
    });
}

// 2026-06-30: removed
export async function builderTailwindCSS() {
    console.warn(
        "[WARNING]: TailwindCSS builder has been removed. Use plugin system."
    );
    return {
        on() {
            console.warn(
                "[WARNING]: TailwindCSS builder has been removed. Use plugin system."
            );
        }
    };
}

const bundler = {
    esbuildVersion,
    bundle,
    prepare,
    bundleFile,
    builderTailwindCSS
};

export default bundler;
