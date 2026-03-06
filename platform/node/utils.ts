import os from "node:os";
import { getVersion } from "../../version.ts";
import path from "node:path";
import url from "node:url";

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

export const version = getVersion(path.resolve(currentDirectory, "..", ".."));

export const fullVersion = `${version.major}.${version.minor}.${version.patch}-${version.build}`;

export const binLocation = path.resolve(
    currentDirectory,
    "..",
    "@fullstacked",
    environment
);
