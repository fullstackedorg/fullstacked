import os from "node:os";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";

export const platform = os.platform();

const archArgIndex = process.argv.indexOf("--arch");
export const arch =
    archArgIndex === -1 ? os.arch() : process.argv.at(archArgIndex + 1);

export const environment = `${platform}-${arch}`;

export const binExtension = platform === "win32" ? "dll" : "so";

export const binBasename = `fullstacked.${binExtension}`;

export const bindingBasename = "binding.node";

export const currentDirectory = path.dirname(
    url.fileURLToPath(import.meta.url)
);

export const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(currentDirectory, "package.json"), "utf-8")
);

export const binLocation = path.resolve(
    currentDirectory,
    "..",
    "@fullstacked",
    environment
);
