import { bridge } from "../bridge/index.ts";
import { Bundle } from "../@types/index.ts";
import {
    EsbuildVersion,
    EsbuildResult,
    BuilderTailwindCSS,
    BundleDir,
    BundleFile
} from "../@types/bundle.ts";
import path from "../path/index.ts";
import { Duplex } from "../bridge/duplex.ts";
import { EventEmitter } from "../bridge/eventEmitter.ts";

export function esbuildVersion(): Promise<string> {
    return bridge({
        mod: Bundle,
        fn: EsbuildVersion
    });
}

export function bundle(entryPoint: string): Promise<EsbuildResult> {
    const resolved = path.resolve(entryPoint);

    return new Promise(async (resolve) => {
        const ee = (
            (await bridge({
                mod: Bundle,
                fn: BundleDir,
                data: [resolved]
            })) as Duplex
        ).eventEmitter() as EventEmitter<{
            result: [EsbuildResult];
        }>;

        ee.on("result", resolve);
    });
}

export function bundleFile(entryPoint: string): Promise<EsbuildResult> {
    const resolved = path.resolve(entryPoint);

    return bridge({
        mod: Bundle,
        fn: BundleFile,
        data: [resolved]
    });
}

export async function builderTailwindCSS() {
    return (
        (await bridge({
            mod: Bundle,
            fn: BuilderTailwindCSS
        })) as Duplex
    ).eventEmitter() as EventEmitter<{
        // [entryfile, outfile, ...sources]
        build: string[];
        "build-done": undefined;
    }>;
}

export default {
    esbuildVersion,
    bundle,
    bundleFile,
    builderTailwindCSS
};
