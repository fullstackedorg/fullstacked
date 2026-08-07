import path from "node:path";
import { createRequire } from "node:module";
import {
    binBasename,
    bindingBasename,
    binLocations,
    packageJson
} from "../utils.ts";
import fs from "node:fs";

globalThis.require = createRequire(import.meta.url);

export interface Core {
    load(libPath: string): void;
    start(root: string, build: string): number;
    check(ctx: number): boolean;
    stop(ctx: number): void;
    call(payload: ArrayBuffer): ArrayBuffer;
    setOnStreamData(
        cb: (ctx: number, streamId: number, buffer: ArrayBuffer) => void
    ): void;
    end(): void;
}

let core: Core;

function findBinLocation() {
    for (const binLocation of binLocations) {
        if (fs.existsSync(binLocation)) {
            return binLocation;
        }
    }
    return undefined;
}

function verifyVersion(binLocation: string) {
    const packageJsonFileBin = path.resolve(binLocation, "package.json");

    try {
        const packageJsonBin = JSON.parse(
            fs.readFileSync(packageJsonFileBin, { encoding: "utf-8" })
        );
        return packageJsonBin.version === packageJson.version;
    } catch (e) {
        console.log(e);
        return false;
    }
}

export async function load(
    onStreamData: Parameters<(typeof core)["setOnStreamData"]>[0]
) {
    const binLocation = findBinLocation();
    if (!binLocation) {
        throw `Cannot find core library. Tried:\n${binLocations.join("\n")}`;
    }

    if (!verifyVersion(binLocation)) {
        throw `Core library version mismatch. Retry installing fullstacked.`;
    }

    const libPath = path.resolve(binLocation, binBasename);
    const bindingPath = path.resolve(binLocation, bindingBasename);

    core = require(bindingPath);
    core.load(libPath);
    core.setOnStreamData(onStreamData);

    return core;
}
