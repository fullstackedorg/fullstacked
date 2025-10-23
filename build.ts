import path from "node:path";
import fs from "node:fs";
import { getLibPath } from "./platform/node/src/lib";
import { load, setDirectories, callLib } from "./platform/node/src/call";
import { buildNodeBinding } from "./platform/node/build-binding";
import { createRequire } from "node:module";
import { buildCore } from "./build-core";
import { createPayloadHeader } from "./platform/node/src/instance";
import { serializeArgs } from "./fullstacked_modules/bridge/serialization";
import { buildSASS } from "./fullstacked_modules/build/sass";
import version from "./version";
import esbuild from "esbuild";
import { buildLocalProject } from "./platform/node/src/build";
import * as sass from "sass";
globalThis.require = createRequire(import.meta.url);

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

prebuild();

await buildLocalProject(project);

postbuild();

console.log("Success");

exit();

function prebuild() {
    const { css } = sass.compile(
        "fullstacked_modules/components/snackbar.scss"
    );
    fs.writeFileSync("fullstacked_modules/components/snackbar.css", css);
}

function postbuild() {
    const outDir = "out";
    const assets = [
        [`${project}/assets`, "assets"],
        ["node_modules/@fullstacked/ui/icons", "icons"],
        ["fullstacked_modules", "fullstacked_modules"],
        [
            "node_modules/@fullstacked/ai-agent",
            "fullstacked_modules/@fullstacked/ai-agent"
        ],
        ["node_modules/zod", "fullstacked_modules/zod"]
    ];
    const toBundle = [
        [
            "node_modules/sass/sass.default.js",
            "fullstacked_modules/sass/index.js"
        ],
        [
            "node_modules/@fullstacked/ui/ui.ts",
            "fullstacked_modules/@fullstacked/ui/index.js"
        ],
        [
            "node_modules/@fullstacked/ai-agent/src/index.ts",
            "fullstacked_modules/@fullstacked/ai-agent/ai-agent.js"
        ]
    ];

    if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true });
    }
    fs.mkdirSync(outDir);
    fs.renameSync(`${project}/.build`, `${outDir}/build`);

    assets.forEach(([form, to]) => {
        fs.cpSync(form, `${outDir}/build/${to}`, { recursive: true });
    });

    toBundle.forEach(([from, to]) =>
        esbuild.buildSync({
            entryPoints: [from],
            outfile: `${outDir}/build/${to}`,
            bundle: true,
            platform: "browser",
            format: "esm",
            external: ["fetch"]
        })
    );

    const filePath = `${outDir}/build/fullstacked_modules/@fullstacked/ai-agent/package.json`;
    const pacakgeJSON = JSON.parse(
        fs.readFileSync(filePath, { encoding: "utf8" })
    );
    pacakgeJSON.exports = {
        ".": "./ai-agent.js"
    };
    fs.writeFileSync(filePath, JSON.stringify(pacakgeJSON, null, 2));

    fs.writeFileSync(`${outDir}/build/version.json`, JSON.stringify(version));

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
    fs.writeFileSync(`${outDir}/zip/build.txt`, Date.now().toString());

    fs.rmSync("fullstacked_modules/components/snackbar.css");
}
