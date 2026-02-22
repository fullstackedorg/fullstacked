import { bridge } from "../bridge/index.ts";
import { Bundle } from "../@types/index.ts";
import {
    EsbuildVersion,
    Bundle as BundleFn,
    EsbuildResult,
    BuilderTailwindCSS
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
                fn: BundleFn,
                data: [resolved]
            })) as Duplex
        ).eventEmitter() as EventEmitter<{
            result: [EsbuildResult];
        }>;

        ee.on("result", resolve);
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
    builderTailwindCSS
};
