import { bundle } from "../../../../core/internal/bundle/lib/bundle/index.ts";

export async function executeBundle(args?: string[]) {
    const result = await bundle(...(args || []));
    result.Warnings?.forEach((w) => console.log(w));
    result.Errors?.forEach((e) => console.log(e));
    return result.Errors === null;
}
