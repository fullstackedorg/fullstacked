import { bridge } from "../bridge/index.ts";
import { Bundle } from "../@types/index.ts";
import {
    EsbuildVersion,
    EsbuildResult,
    BundleDir,
    BundleFile
} from "../@types/bundle.ts";
import path from "../path/index.ts";
import { Duplex } from "../bridge/duplex.ts";

export function esbuildVersion(): Promise<string> {
    return bridge({
        mod: Bundle,
        fn: EsbuildVersion
    });
}

export function bundle(entryPoint?: string): Promise<EsbuildResult> {
    const resolved = path.resolve(entryPoint ?? ".");

    return new Promise(async (resolve) => {
        const ee = (
            (await bridge({
                mod: Bundle,
                fn: BundleDir,
                data: [resolved]
            })) as Duplex
        ).eventEmitter() as any;

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

const bundler = {
    esbuildVersion,
    bundle,
    bundleFile
};

export default bundler;
