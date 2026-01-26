import path from "node:path";
import url from "node:url";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

const libModulesLocation = path.resolve(
    currentDirectory,
    "..",
    "..",
    "core",
    "internal",
    "bundle",
    "lib"
);

export async function execute(command: string[]) {
    const libModule = await import(
        libModulesLocation + "/" + command[0] + "/index.ts"
    );
    console.log(libModule[command[1]](...command.slice(2)));
}
