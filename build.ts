import path from "node:path";
import fs from "node:fs";
import { getLibPath } from "./platform/node/src/lib";
import { load, setDirectories, setCallback } from "./platform/node/src/call";
import { buildNodeBinding } from "./platform/node/build-binding";
import { createRequire } from "node:module";
import { buildCore } from "./build-core";
import { createInstance } from "./platform/node/src/instance";
import { serializeArgs } from "./fullstacked_modules/bridge/serialization";
import { buildSASS } from "./build-sass";
import version from "./version";
globalThis.require = createRequire(import.meta.url);

const exit = () => process.exit();
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => process.on(signal, exit));

buildCore();

buildNodeBinding("platform/node");

load(await getLibPath("core/bin"), "platform/node");

const project = "editor";

setCallback(async (_, messageType, message) => {
    if (messageType === "build-style") {
        const { id, entryPoint, projectId } = JSON.parse(message);
        const result = await buildSASS(
            fs.readFileSync(path.join(projectId, entryPoint), {
                encoding: "utf8"
            }),
            {
                canonicalize: (filePath) =>
                    filePath.startsWith("file://")
                        ? new URL(filePath)
                        : new URL(
                              path.resolve(process.cwd(), projectId, filePath),
                              "file://"
                          ),
                load: (url) => fs.readFileSync(url, { encoding: "utf8" })
            }
        );
        instance.call(
            new Uint8Array([58, ...serializeArgs([id, JSON.stringify(result)])])
        );
    } else if (messageType === "build") {
        const { errors } = JSON.parse(message);

        if (errors.length) {
            errors.forEach((e) => {
                console.log(`${e.Location.File}#${e.Location.Line}`);
                console.log(e.Text + "\n");
            });
            throw "failed";
        } else {
            postBuild();
        }

        exit();
    }
});

setDirectories({
    root: process.cwd(),
    config: "",
    editor: "",
    tmp: path.resolve(process.cwd(), ".cache")
});

const instance = createInstance("", true);
instance.call(new Uint8Array([56, ...serializeArgs([project, 0])]));

const outDir = "out";
const assetsDir = [
    [`${project}/assets`, "assets"],
    ["node_modules/@fullstacked/ui/icons", "icons"]
];

function postBuild() {
    if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true });
    }
    fs.mkdirSync(outDir);
    fs.renameSync(`${project}/.build`, `${outDir}/build`);

    assetsDir.forEach(([form, to]) => {
        fs.cpSync(form, `${outDir}/build/${to}`, { recursive: true });
    });

    fs.writeFileSync(`${outDir}/build/version.json`, JSON.stringify(version));

    // zip demo
    instance.call(
        new Uint8Array([
            36,
            ...serializeArgs([`demo`, `${outDir}/build/demo.zip`])
        ])
    );

    // zip build
    instance.call(
        new Uint8Array([
            36,
            ...serializeArgs([`${outDir}/build`, `${outDir}/build.zip`])
        ])
    );

    console.log("Success");
}
