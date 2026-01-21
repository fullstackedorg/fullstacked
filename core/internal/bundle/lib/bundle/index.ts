import { bridge } from "../bridge/index.ts";
import { Bundle } from "../@types/index.ts";
import {
    EsbuildErrorsAndWarning,
    EsbuildVersion,
    Bundle as BundleFn
} from "../@types/bundle.ts";

export function esbuildVersion(): Promise<string> {
    return bridge({
        mod: Bundle,
        fn: EsbuildVersion
    });
}

export function bundle(
    ...entryPoints: string[]
): Promise<EsbuildErrorsAndWarning> {
    return bridge({
        mod: Bundle,
        fn: BundleFn,
        data: [...entryPoints]
    });
}
