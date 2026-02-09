import { bridge } from "../bridge/index.ts";
import { Bundle } from "../@types/index.ts";
import {
    EsbuildVersion,
    Bundle as BundleFn,
    EsbuildResult
} from "../@types/bundle.ts";
import path from "../path/index.ts";

export function esbuildVersion(): Promise<string> {
    return bridge({
        mod: Bundle,
        fn: EsbuildVersion
    });
}

export function bundle(entryPoint: string): Promise<EsbuildResult> {
    const resolve = path.resolve(entryPoint);
    return bridge({
        mod: Bundle,
        fn: BundleFn,
        data: [resolve]
    });
}

export default {
    esbuildVersion,
    bundle
};
