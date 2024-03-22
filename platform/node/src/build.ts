import fs from "fs";
import type esbuild from "esbuild";

export async function merge(
    baseFile: string,
    entryPoint: string,
    cacheDirectory: string
){
    const mergedContent = `${await fs.promises.readFile(baseFile)}\nimport("${entryPoint}");`;
    await fs.promises.mkdir(cacheDirectory, {recursive: true});
    const tmpFile = `${cacheDirectory}/tmp-${Date.now()}.js`;
    await fs.promises.writeFile(tmpFile, mergedContent);
    return tmpFile;
}

export function build(
    buildSync: typeof esbuild.buildSync,
    input: string,
    out: string,
    outdir: string,
    nodePath: string,
    sourcemap: esbuild.BuildOptions["sourcemap"] = "inline",
    splitting = true
) {
    try {
        buildSync({
            entryPoints: [{
                in: input,
                out
            }],
            outdir,
            splitting,
            bundle: true,
            format: "esm",
            minify: true,
            sourcemap,
            write: true,
            logLevel: "silent",
            nodePaths: nodePath ? [nodePath] : undefined
        });
    } catch (e) {
        return { errors: e.errors as esbuild.ResolveResult["errors"] };
    }
}
