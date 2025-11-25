import path from "node:path";
import { promises as fs } from "node:fs";
import { getLibPath } from "./platform/node/src/lib";
import { load, setDirectories, callLib } from "./platform/node/src/call";
import { buildNodeBinding } from "./platform/node/build-binding";
import { createRequire } from "node:module";
import { buildCore } from "./build-core";
import { createPayloadHeader } from "./platform/node/src/instance";
import { serializeArgs } from "./fullstacked_modules/bridge/serialization";
import version, { getVersion } from "./version";
import { buildLocalProject } from "./platform/node/src/build";
globalThis.require = createRequire(import.meta.url);

const noTSGO = process.argv.includes("--no-tsgo");

const exit = () => process.exit();
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => process.on(signal, exit));

buildCore(noTSGO);

buildNodeBinding("platform/node");

load(await getLibPath("core/bin"), "platform/node");

const project = "editor";

setDirectories({
    root: process.cwd(),
    config: "",
    editor: process.cwd(),
    tmp: path.resolve(process.cwd(), ".cache")
});

await buildLocalProject(project);

await postbuild();

console.log("Success");

exit();

async function postbuild() {
    if (!noTSGO) {
        await import("./declarations.js");
    }

    const outDir = "out";
    const assets = [
        [`${project}/assets`, "assets"],
        ["node_modules/@fullstacked/ui/icons", "icons"],
        ["fullstacked_modules", "fullstacked_modules"]
    ];

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.rename(`${project}/.build`, `${outDir}/build`);

    for (const [from, to] of assets) {
        await fs.cp(from, `${outDir}/build/${to}`, {
            recursive: true,
            force: true
        });
    }

    (await import("./build-sass.js")).buildSASS(
        `${outDir}/build/fullstacked_modules/sass/index.js`
    );

    await fs.writeFile(`${outDir}/build/version.json`, JSON.stringify(version));

    if (!noTSGO) {
        await fs.writeFile(
            `${outDir}/build/version-tsgo.json`,
            JSON.stringify(getVersion("core/typescript-go"))
        );
    }

    // zip demo
    callLib(
        new Uint8Array([
            ...createPayloadHeader({
                id: "",
                isEditor: true
            }),
            36,
            ...serializeArgs([`demo`, `${outDir}/build/demo.zip`])
        ])
    );

    // zip build
    callLib(
        new Uint8Array([
            ...createPayloadHeader({
                id: "",
                isEditor: true
            }),
            36,
            ...serializeArgs([`${outDir}/build`, `${outDir}/zip/build.zip`])
        ])
    );
    await fs.writeFile(`${outDir}/zip/build.txt`, Date.now().toString());
}
