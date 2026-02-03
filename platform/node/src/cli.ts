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

async function execute(command: string[]) {
    const libModule = await import(
        libModulesLocation + "/" + command[0] + "/index.ts"
    );
    let out = libModule[command[1]](...command.slice(2));

    if (out instanceof Promise) {
        out = await out;
    }

    if (out?.[Symbol.asyncIterator]) {
        for await (const chunk of out) {
            process.stdout.write(chunk);
        }
    } else {
        console.log(out);
    }
}
