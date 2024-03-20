import type { fs as globalFS } from "../../../src/adapter/fs";

declare var fs: typeof globalFS;
declare var jsDirectory: string;
declare var resolvePath: (entrypoint: string) => string;

const cacheDirectory = ".cache/fullstacked";
const mkCacheDir = async () => {
    if (!(await fs.exists(cacheDirectory))) {
        await fs.mkdir(cacheDirectory);
    }
};

export const mingleWebview = async (entryPoint: string) => {
    const mergedContent = `${await fs.readFile(jsDirectory + "/webview.js", { absolutePath: true, encoding: "utf8" })}
import("${resolvePath(entryPoint)}");`;

    await mkCacheDir();
    const tmpFile = `${cacheDirectory}/tmp-${Date.now()}.js`;
    await fs.writeFile(tmpFile, mergedContent);
    return tmpFile;
};

export const mingleAPI = async (entryPoint?: string) => {
    let mergedContent = `${await fs.readFile(jsDirectory + "/api.js", { absolutePath: true, encoding: "utf8" })}`;

    if (entryPoint) {
        mergedContent += `globalThis.userMethods = require("${resolvePath(entryPoint)}")?.default ?? {};`;
    }

    await mkCacheDir();
    const tmpFile = `${cacheDirectory}/tmp-${Date.now()}.js`;
    await fs.writeFile(tmpFile, mergedContent);
    return tmpFile;
};
