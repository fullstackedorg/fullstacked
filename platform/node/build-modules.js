import path from "node:path";
import fs from "node:fs";

await import("../../declarations.js");

const currentDirectory = import.meta.dirname;
const rootDirectory = path.resolve(currentDirectory, "..", "..");

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

(await import("../../build-sass.js")).buildSASS(
    path.resolve(fullstackedModulesDirectory, "sass", "index.js")
);
