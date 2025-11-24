import esbuild from "esbuild";
import path from "node:path"

const currentDirectory = import.meta.dirname

export function buildSASS(to) {
    return esbuild.build({
        entryPoints: [path.resolve(currentDirectory, "node_modules","sass","sass.default.js")],
        outfile: to,
        bundle: true,
        platform: "browser",
        format: "esm"
    })
}
