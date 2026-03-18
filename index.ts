import "./build.ts";
import "./platform/node/build.ts";
import fs from "fs";
import { getVersion } from "./version.ts";

if (fs.existsSync("app/shell")) {
    // this is a duplicate of the shell/prestart.ts
    // at some point, there won't be any default app in this repository
    // for now we keep the shell and demo as submodule to accelerate the development

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

    const shellVersion = getVersion("app/shell");
    fs.writeFileSync(
        "app/out/.build",
        `${shellVersion.major}.${shellVersion.minor}.${shellVersion.patch}, branch ${shellVersion.branch}, hash ${shellVersion.hash.substring(0, 8)}`
    );
}

await import("./platform/node/index.js");
