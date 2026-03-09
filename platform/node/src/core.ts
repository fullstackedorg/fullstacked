import path from "node:path";
import { createRequire } from "node:module";
import {
    binBasename,
    bindingBasename,
    binLocation,
    environment,
    packageJson
} from "../utils.ts";
import fs from "node:fs";
import child_process from "node:child_process";

globalThis.require = createRequire(import.meta.url);

export interface Core {
    load(libPath: string): void;
    start(root: string, build: string): number;
    stop(ctx: number): void;
    call(payload: ArrayBuffer): ArrayBuffer;
    setOnStreamData(
        cb: (ctx: number, streamId: number, buffer: ArrayBuffer) => void
    ): void;
    end(): void;
}

let core: Core;

function verifyVersion() {
    const packageJsonFileBin = path.resolve(binLocation, "package.json");

    try {
        const packageJsonBin = JSON.parse(
            fs.readFileSync(packageJsonFileBin, { encoding: "utf-8" })
        );
        return packageJsonBin.version === packageJson.version;
    } catch (e) {
        return false;
    }
}

export async function load(
    onStreamData: Parameters<(typeof core)["setOnStreamData"]>[0]
) {
    if (fs.existsSync(binLocation) && verifyVersion()) {
        const libPath = path.resolve(binLocation, binBasename);
        const bindingPath = path.resolve(binLocation, bindingBasename);
        core = require(bindingPath);
        core.load(libPath);
        core.setOnStreamData(onStreamData);
        return core;
    }

    if (process.env.FULLSTACKED_DEBUG) {
        throw `Cannot find core library at ${binLocation}`;
    }

    child_process.execSync(
        `npm i --no-save @fullstacked/${environment}@${packageJson.version}`,
        {
            stdio: "inherit"
        }
    );

    return load(onStreamData);
}
