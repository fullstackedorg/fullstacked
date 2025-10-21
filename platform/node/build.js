import esbuild from "esbuild";
import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import { buildNodeBinding } from "./build-binding.js"

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

esbuild.buildSync({
    entryPoints: ["src/index.ts"],
    outfile: "index.js",
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node"
});

const fullstackedModulesDirectory = path.resolve(
    currentDirectory,
    "fullstacked_modules"
);

if (fs.existsSync(fullstackedModulesDirectory)) {
    fs.rmSync(fullstackedModulesDirectory, { recursive: true });
}

fs.cpSync(
    path.resolve(rootDirectory, "fullstacked_modules"),
    fullstackedModulesDirectory,
    { recursive: true }
);

buildNodeBinding(currentDirectory) 