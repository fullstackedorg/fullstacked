import esbuild from "esbuild";
import path from "node:path";
import url from "node:url";
import { buildNodeBinding } from "./build-binding.js";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

buildNodeBinding(currentDirectory);

esbuild.buildSync({
    entryPoints: ["src/index.ts"],
    outfile: "index.js",
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node"
});
