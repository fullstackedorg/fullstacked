// @ts-ignore
import bundle from "bundle";
import { init, build } from "@fullstacked/builder-tailwindcss";

const builder = await bundle.builderTailwindCSS();

builder.on("build", async (entryfile, outfile, ...sources) => {
    await init({
        oxide: "node_modules/oxide-wasm/pkg/oxide_wasm_bg.wasm",
        lightningcss: "node_modules/lightningcss-wasm/lightningcss_node.wasm",
        tailwindcss: "node_modules/tailwindcss"
    });

    await build(entryfile, outfile, sources);

    builder.writeEvent("build-done");
});

await bundle.bundle("./project");

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "./project/out/index.ts.tailwind.css";
document.head.appendChild(link);

await import("./project/index.ts");

