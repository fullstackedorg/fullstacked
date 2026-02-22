import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import {
    init,
    build as buildTailwindCSS
} from "@fullstacked/builder-tailwindcss/index.ts";
import fs from "node:fs";

export function cleanup() {
    fs.rmSync("test/bundle/samples/basic/_index.ts.js", { force: true });
    fs.rmSync("test/bundle/samples/css/_index.ts.css", { force: true });
    fs.rmSync("test/bundle/samples/css/_index.ts.js", { force: true });
    fs.rmSync("test/bundle/samples/tailwindcss/_index.ts.tailwind.css", {
        force: true
    });
    fs.rmSync("test/bundle/samples/tailwindcss/_index.ts.js", { force: true });
    fs.rmSync("test/bundle/samples/tailwindcss/output.css", { force: true });
    fs.rmSync("test/bundle/samples/tailwindcss/build/_index.ts.js", {
        force: true
    });
    fs.rmSync(
        "test/bundle/samples/tailwindcss/build/_tailwind.ts.tailwind.css",
        { force: true }
    );
    fs.rmSync("test/bundle/samples/tailwindcss/build/_tailwind.ts.js", {
        force: true
    });
    fs.rmSync("test/bundle/samples/tailwindcss/build/node_modules", {
        force: true,
        recursive: true
    });
}

export async function tailwindcssBuilder() {
    const builder = await bundle.builderTailwindCSS();

    builder.on("build", async (entryfile, outfile, ...sources) => {
        await init({
            oxide: "node_modules/oxide-wasm/pkg/oxide_wasm_bg.wasm",
            lightningcss:
                "node_modules/lightningcss-wasm/lightningcss_node.wasm",
            tailwindcss: "node_modules/tailwindcss"
        });

        await buildTailwindCSS(entryfile, outfile, sources, true);

        builder.writeEvent("build-done");
    });

    return {
        end: () => builder.duplex.end()
    };
}
