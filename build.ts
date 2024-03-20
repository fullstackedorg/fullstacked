import fs from "fs";
import path from "path";
import * as sass from "sass";
import { buildWebview } from "./platform/node/src/build";
import { buildSync } from "esbuild";
import { mingleAPI, mingleWebview } from "./editor/api/projects/mingle";
import { scan } from "./editor/api/projects/scan";
import esbuild from "esbuild";
import AdmZip from "adm-zip";

if (fs.existsSync("editor/build"))
    fs.rmSync("editor/build", { recursive: true });

global.fs = {
    readdir: (directory: string) =>
        fs.readdirSync(directory, { withFileTypes: true }).map((item) => ({
            name: item.name,
            isDirectory: item.isDirectory()
        })),
    readFile: (file: string) => fs.readFileSync(file, { encoding: "utf-8" }),
    writeFile: (file: string, contents: string) =>
        fs.writeFileSync(file, contents),
    exists: (itemPath: string) => fs.existsSync(itemPath),
    mkdir: (itemPath: string) => fs.mkdirSync(itemPath, { recursive: true })
};
global.jsDirectory = "src/js";
global.resolvePath = (entrypoint: string) => entrypoint.split("\\").join("/");
global.esbuild = esbuild;

const scssFiles = (await scan("editor/webview")).filter((filePath) =>
    filePath.endsWith(".scss")
);

const compileScss = async (scssFile: string) => {
    const { css } = await sass.compileAsync(scssFile);
    if (css.length) fs.writeFileSync(scssFile.slice(0, -4) + "css", css);
};
const compilePromises = scssFiles.map(compileScss);
await Promise.all(compilePromises);

buildSync({
    entryPoints: ["src/webview/index.ts"],
    bundle: true,
    format: "esm",
    outfile: "src/js/webview.js"
});

const entrypointWebview = await mingleWebview("../../editor/webview/index.ts");
buildWebview(entrypointWebview, "editor/build/webview", undefined, false);
fs.rmSync(entrypointWebview);

// cleanup
scssFiles.forEach((scssFile) => {
    const cssFile = scssFile.slice(0, -4) + "css";
    if (fs.existsSync(cssFile)) fs.rmSync(cssFile);
});

fs.cpSync("editor/webview/index.html", "editor/build/webview/index.html");
fs.cpSync("editor/webview/assets", "editor/build/webview/assets", {
    recursive: true
});

if (fs.existsSync("editor-sample-demo")) {
    const demoFiles = await scan("editor-sample-demo");
    var zip = new AdmZip();
    demoFiles.forEach((item) => {
        const itemPathComponents = item.split("/");
        const itemName = itemPathComponents.pop();
        const itemDirectory = itemPathComponents.slice(1).join("/");
        zip.addLocalFile(item, itemDirectory, itemName);
    });
    zip.writeZip("Demo.zip");
}
