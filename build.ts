import path from "node:path";
import { promises as fs } from "node:fs";
import { getLibPath } from "./platform/node/src/lib";
import { load, setDirectories, callLib } from "./platform/node/src/call";
import { buildNodeBinding } from "./platform/node/build-binding";
import { createRequire } from "node:module";
import { buildCore } from "./build-core";
import { createPayloadHeader } from "./platform/node/src/instance";
import { serializeArgs } from "./fullstacked_modules/bridge/serialization";
import version from "./version";
import esbuild from "esbuild";
import { buildLocalProject } from "./platform/node/src/build";
globalThis.require = createRequire(import.meta.url);

await import("./declarations.js");

const exit = () => process.exit();
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => process.on(signal, exit));

buildCore();

buildNodeBinding("platform/node");

load(await getLibPath("core/bin"), "platform/node");

const project = "editor";

setDirectories({
    root: process.cwd(),
    config: "",
    editor: "",
    tmp: path.resolve(process.cwd(), ".cache")
});

await buildLocalProject(project);

await postbuild();

console.log("Success");

exit();

async function postbuild() {
    const outDir = "out";
    const assets = [
        [`${project}/assets`, "assets"],
        ["node_modules/@fullstacked/ui/icons", "icons"],
        ["fullstacked_modules", "fullstacked_modules"]
    ];
    const toBundle = [
        [
            "node_modules/sass/sass.default.js",
            "fullstacked_modules/sass/index.js"
        ],
        [
            "node_modules/@fullstacked/ui/ui.ts",
            "fullstacked_modules/@fullstacked/ui/index.js"
        ]
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

    const bundlePromises = toBundle.map(([from, to]) =>
        esbuild.build({
            entryPoints: [from],
            outfile: `${outDir}/build/${to}`,
            bundle: true,
            platform: "browser",
            format: "esm",
            external: ["fetch"]
        })
    );
    await Promise.all(bundlePromises);

    await fs.writeFile(`${outDir}/build/version.json`, JSON.stringify(version));

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
