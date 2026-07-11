import plugin from "../../core/internal/bundle/lib/plugin/index.ts";
import pluginTailwindcss, {
    initialize
} from "../../plugins/tailwindcss/index.ts";
import pluginSass from "../../plugins/sass/index.ts";
import fs from "node:fs";

export function cleanup() {
    fs.rmSync("test/bundle/samples/basic/out", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/file/index.ts.js", { force: true });
    fs.rmSync("test/bundle/samples/css/out", { force: true, recursive: true });
    fs.rmSync("test/bundle/samples/tailwindcss/out", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/tailwindcss/output.css", { force: true });
    fs.rmSync("test/bundle/samples/tailwindcss/build/out", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/tailwindcss/build/node_modules", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/tailwindcss/build/project/out", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/sass/out", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/sass/output.css", {
        force: true
    });
    fs.rmSync("test/bundle/samples/browser-only/out", {
        force: true,
        recursive: true
    });
}

export async function tailwindcssBuilder() {
    await initialize({
        skipLightning: true
    });
    const p = await plugin.register("build", pluginTailwindcss);

    return {
        end: () => p.unregister()
    };
}

export async function sassBuilder() {
    const p = await plugin.register("build", pluginSass);

    return {
        end: () => p.unregister()
    };
}
