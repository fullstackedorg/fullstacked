import esbuild from "esbuild";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import { buildNodeBinding } from "./build-binding.js";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

if (process.argv.includes("--binding")) {
    buildNodeBinding(currentDirectory);
} else {
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
        path.resolve(rootDirectory, "out", "build", "fullstacked_modules"),
        fullstackedModulesDirectory,
        { recursive: true }
    );
}
