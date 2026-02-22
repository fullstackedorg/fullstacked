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

await bundle.bundle("./tailwind.ts");

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "./_tailwind.ts.tailwind.css";
document.head.appendChild(link);

await import("./tailwind");

document.body.classList.add("done");
