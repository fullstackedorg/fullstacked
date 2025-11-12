import { createPayloadHeader } from "./instance";
import { callLib, CoreCallbackListeners } from "./call";
import { buildSASS } from "../../../fullstacked_modules/build/sass";
import fs from "node:fs";
import path from "node:path";
import { serializeArgs } from "../../../fullstacked_modules/bridge/serialization";
import jsdom from "jsdom";

function quickInstallPackage(editorHeader: Uint8Array, directory: string) {
    return new Promise<void>((resolve) => {
        const cb = (_: string, messageType: string, message: string) => {
            if (messageType === "packages-installation") {
                const { duration } = JSON.parse(message);
                if (typeof duration !== "undefined") {
                    CoreCallbackListeners.delete(cb);
                    resolve();
                }
            }
        };
        CoreCallbackListeners.add(cb);

        // package install quick
        callLib(
            new Uint8Array([
                ...editorHeader,
                61,
                ...serializeArgs([directory, 0])
            ])
        );
    });
}

async function buildStyle(entrypoint: string) {
    globalThis.document = new jsdom.JSDOM().window.document;
    return {
        css: (await import(entrypoint)).exportStyles(),
        errors: []
    };
}

export async function buildLocalProject(directory: string) {
    const editorHeader = createPayloadHeader({
        id: "",
        isEditor: true
    });

    await quickInstallPackage(editorHeader, directory);

    return new Promise<void>(async (resolve, reject) => {
        const cb = async (_: string, messageType: string, message: string) => {
            if (messageType === "build-style") {
                const { id, entryPoint, projectId } = JSON.parse(message);
                const result = entryPoint.endsWith(".js")
                    ? await buildStyle(
                          "file://" +
                              path
                                  .resolve(process.cwd(), projectId, entryPoint)
                                  .replace(/\\/g, "/")
                      )
                    : await buildSASS(entryPoint, {
                          canonicalize: (filePath) =>
                              filePath.startsWith("file://")
                                  ? new URL(filePath)
                                  : new URL(
                                        "file://" +
                                            path
                                                .resolve(
                                                    process.cwd(),
                                                    projectId,
                                                    filePath
                                                )
                                                .replace(/\\/g, "/")
                                    ),
                          load: (url) =>
                              fs.readFileSync(url, { encoding: "utf8" })
                      });
                callLib(
                    new Uint8Array([
                        ...editorHeader,
                        58,
                        ...serializeArgs([id, JSON.stringify(result)])
                    ])
                );
            } else if (messageType === "build") {
                const { errors } = JSON.parse(message);

                if (errors.length) {
                    errors.forEach((e) => {
                        try {
                            console.log(
                                `${e.Location.File}#${e.Location.Line}`
                            );
                            console.log(e.Text + "\n");
                        } catch (_) {
                            console.log(e);
                        }
                    });
                    reject();
                } else {
                    resolve();
                }
            }
        };
        CoreCallbackListeners.add(cb);

        // build project
        callLib(
            new Uint8Array([
                ...editorHeader,
                56,
                ...serializeArgs([directory, 0])
            ])
        );
    });
}
