import fs from "fs";
import esbuild from "esbuild";

if (fs.existsSync("out")) {
    fs.rmSync("out", { recursive: true });
}
fs.mkdirSync("out/bin", { recursive: true });
fs.mkdirSync("out/site", { recursive: true });

fs.cpSync("../../core/bin/fullstacked.wasm", "out/bin/fullstacked.wasm");
fs.cpSync("../../core/bin/wasm_exec.js", "out/bin/wasm_exec.js");

const editorZipFileName = fs
    .readdirSync("../../out/zip")
    .find((item) => item.startsWith("editor"));
fs.cpSync(`../../out/zip/${editorZipFileName}`, "out/bin/editor.zip");

esbuild.buildSync({
    entryPoints: ["src/index.ts"],
    outfile: "out/site/index.js",
    bundle: true,
    format: "esm",
    define: {
        "process.env.baseUrl": `"${process.argv.includes("dev") ? "http://localhost:9000/bin" : ""}"`
    }
});

["src/dev-icon.png", "src/index.html"].forEach((f) =>
    fs.cpSync(f, "out/site" + f.slice("src".length))
);
