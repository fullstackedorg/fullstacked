import { promises } from "node:fs";
import { createPayloadHeader } from "./instance";
import { callLib } from "./call";
import {
    deserializeArgs,
    serializeArgs
} from "../../../fullstacked_modules/bridge/serialization";
import { toByteArray } from "../../../fullstacked_modules/base64";
import { cbListener } from ".";
import type { Message } from "esbuild";

function quickInstallPacakge(editorHeader: Uint8Array) {
    return new Promise<void>((resolve) => {
        const cb = (_: string, messageType: string, message: string) => {
            if (messageType === "packages-installation") {
                const { duration } = JSON.parse(message);
                if (typeof duration !== "undefined") {
                    cbListener.delete(cb);
                    resolve();
                }
            }
        };
        cbListener.add(cb);

        // package install quick
        callLib(
            new Uint8Array([...editorHeader, 61, ...serializeArgs([".", 0])])
        );
    });
}

export async function buildLocalProject() {
    const editorHeader = createPayloadHeader({
        id: "",
        isEditor: true
    });

    await quickInstallPacakge(editorHeader);

    return new Promise<void>(async (resolve) => {
        const cb = (_: string, messageType: string, message: string) => {
            if (messageType === "build") {
                cbListener.delete(cb);
                const data = toByteArray(message);
                const [_, errorsStr] = deserializeArgs(data);
                let buildErrors: Message[];
                try {
                    buildErrors = JSON.parse(errorsStr);
                    if (buildErrors === null) {
                        resolve();
                        return;
                    }
                } catch (e) {}
                console.log(buildErrors || errorsStr);
                process.exit(1);
            }
        };
        cbListener.add(cb);

        // esbuild build
        callLib(
            new Uint8Array([...editorHeader, 56, ...serializeArgs([".", 0])])
        );
    });
}
