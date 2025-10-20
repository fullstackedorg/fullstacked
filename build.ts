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
globalThis.require = createRequire(import.meta.url);

const exit = () => process.exit();

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, exit)
);

buildCore();

buildNodeBinding("platform/node");

load(await getLibPath("core/bin"), "platform/node");

setCallback((_, messageType, message) => {
    if (messageType === "build-style") {
        const { id, entryPoint } = JSON.parse(message);
        const result = buildSASS(entryPoint);
        instance.call(new Uint8Array([
            58,
            ...serializeArgs([id, JSON.stringify(result)])
        ]))
    } else if (messageType === "build") {
        const { errors } = JSON.parse(message)

        if (errors.length) {
            errors.forEach(e => {
                console.log(`${e.Location.File}#${e.Location.Line}`)
                console.log(e.Text + "\n")
            })
        } else {
            postBuild();
        }

        exit();
    }
})

setDirectories({
    root: process.cwd(),
    config: "",
    editor: "",
    tmp: path.resolve(process.cwd(), ".cache")
})

const project = "editor";

const instance = createInstance("", true);
instance.call(new Uint8Array([
    56,
    ...serializeArgs([project, 0])
]))

const outDir = "out";
const assetsDir = "assets";

function postBuild() {
    if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true })
    }
    fs.mkdirSync(outDir);
    fs.renameSync(`${project}/.build`, `${outDir}/build`)

    if (fs.existsSync(`${project}/${assetsDir}`)) {
        fs.cpSync(`${project}/${assetsDir}`, `${outDir}/build/${assetsDir}`, { recursive: true });
    }
    
    instance.call(new Uint8Array([
        36,
        ...serializeArgs([`${outDir}/build`, `${outDir}/build.zip`])
    ]))

    console.log("Success")
}

// const production = process.argv.includes("--production");

// const outDir = "out";
// const outDirEditor = `${outDir}/editor`;
// const outDirFullStackedModules = `${outDirEditor}/fullstacked_modules`;

// if (fs.existsSync(outDir)) {
//     fs.rmSync(outDir, { recursive: true });
// }

// async function processScss(entryPoint: string, out: string) {
//     const { css } = await sass.compileAsync(entryPoint, {
//         style: production ? "compressed" : "expanded",
//         importers: [
//             {
//                 findFileUrl(urlStr, _) {
//                     if (urlStr.startsWith("../node_modules")) {
//                         return new URL(
//                             path
//                                 .resolve(process.cwd(), urlStr.slice(1))
//                                 .replace(/\\/g, "/")
//                                 .split(":")
//                                 .pop(),
//                             `file://`
//                         );
//                     }
//                     return null;
//                 }
//             }
//         ]
//     });
//     await fs.promises.writeFile(out, css);
// }

// await processScss("editor/index.scss", `editor/index.css`);

// const toBuild = [["editor/index.ts", "index"]];

// for (const [input, output] of toBuild) {
//     esbuild.buildSync({
//         entryPoints: [
//             {
//                 in: input,
//                 out: output
//             }
//         ],
//         bundle: true,
//         format: "esm",
//         outdir: outDirEditor,
//         sourcemap: production ? false : "external",
//         splitting: false,
//         minify: production,
//         nodePaths: ["node_modules", "fullstacked_modules"]
//     });
// }

// fs.rmSync("editor/index.css");

// fs.cpSync("editor/index.html", `${outDirEditor}/index.html`);
// fs.cpSync("editor/assets", `${outDirEditor}/assets`, {
//     recursive: true
// });

// await processScss("editor/style/windows.scss", `${outDirEditor}/windows.css`);
// await processScss("editor/style/apple.scss", `${outDirEditor}/apple.css`);

// fs.cpSync("node_modules/@fullstacked/ui/icons", `${outDirEditor}/icons`, {
//     recursive: true
// });

// const sampleDemoDir = "demo";
// if (fs.existsSync(sampleDemoDir)) {
//     const zip = new AdmZip();
//     zip.addLocalFolder(sampleDemoDir, "", (file) => !file.startsWith(".git"));
//     zip.writeZip(`${outDirEditor}/Demo.zip`);
// }

// fs.cpSync("node_modules/typescript/lib", outDirEditor + "/tsLib", {
//     recursive: true
// });
// fs.cpSync("fullstacked_modules", outDirFullStackedModules, {
//     recursive: true,
//     filter: (s) => !s.endsWith(".scss")
// });

// esbuild.buildSync({
//     entryPoints: [outDirFullStackedModules + "/ai/index.ts"],
//     outfile: outDirFullStackedModules + "/ai/index.js",
//     format: "esm",
//     bundle: true,
//     external: ["fetch", "fs"]
// });

// const neededModules = ["@fullstacked/ai-agent", "@fullstacked/ui", "zod"];
// neededModules.forEach((m) => {
//     fs.cpSync("node_modules/" + m, outDirFullStackedModules + "/" + m, {
//         recursive: true,
//         filter: (n) =>
//             !n.endsWith(".js") &&
//             !n.endsWith(".cjs") &&
//             !n.startsWith("node_modules/" + m + "/node_modules")
//     });
// });

// esbuild.buildSync({
//     entryPoints: ["node_modules/sass/sass.default.js"],
//     outfile: outDirFullStackedModules + "/sass/index.js",
//     format: "esm",
//     bundle: true,
//     platform: "node"
// });

// const dummyDts = ["@fullstacked", "sass"];

// dummyDts.forEach((dir) =>
//     fs.writeFileSync(outDirFullStackedModules + "/" + dir + "/index.d.ts", "")
// );

// await processScss(
//     "fullstacked_modules/components/snackbar.scss",
//     `${outDirEditor}/fullstacked_modules/components/snackbar.css`
// );

// fs.writeFileSync(`${outDirEditor}/version.json`, JSON.stringify(version));

// if (!process.argv.includes("--no-zip")) {
//     const outZipDir = `${outDir}/zip`;
//     const outZip = `${outZipDir}/editor-${production ? version.build : Date.now()}.zip`;
//     const zip = new AdmZip();
//     zip.addLocalFolder(outDirEditor);
//     fs.mkdirSync(outZipDir, { recursive: true });
//     zip.writeZip(outZip);
// }
