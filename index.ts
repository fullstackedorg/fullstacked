import "./build.ts";
import "./platform/node/build.ts";
import fs from "fs";

await Promise.all([
    fs.promises.cp(
        "app/shell/node_modules/oxide-wasm/pkg/oxide_wasm_bg.wasm",
        "app/out/oxide_wasm_bg.wasm"
    ),
    fs.promises.cp(
        "app/shell/node_modules/lightningcss-wasm/lightningcss_node.wasm",
        "app/out/lightningcss_node.wasm"
    ),
    fs.promises.cp(
        "app/shell/node_modules/tailwindcss",
        "app/out/tailwindcss",
        {
            recursive: true
        }
    )
]);

await import("./platform/node/index.js");
