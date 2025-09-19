import fs from "fs";
import esbuild from "esbuild";

if (fs.existsSync("out")) {
    fs.rmSync("out", { recursive: true });
}
fs.mkdirSync("out", { recursive: true });

fs.cpSync("../../core/bin/fullstacked.wasm", "out/fullstacked.wasm");
fs.cpSync("../../core/bin/wasm_exec.js", "out/wasm_exec.js");

const wasmSize = fs.statSync("out/fullstacked.wasm").size;

const editorZipFileName = fs
    .readdirSync("../../out/zip")
    .find((item) => item.startsWith("editor"));
fs.cpSync(`../../out/zip/${editorZipFileName}`, "out/editor.zip");

esbuild.buildSync({
    entryPoints: ["src/index.ts"],
    outfile: "out/index.js",
    bundle: true,
    format: "esm",
    define: {
        "process.env.wasmSize": wasmSize.toString()
    }
});

["src/dev-icon.png", "src/index.html"].forEach((f) =>
    fs.cpSync(f, "out" + f.slice("src".length))
);
