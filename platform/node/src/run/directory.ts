import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { bundle } from "../../../../core/internal/bundle/lib/bundle/index.ts";
import { run } from "../../../../core/internal/bundle/lib/run/index.ts";
import plugin from "../../../../core/internal/bundle/lib/plugin/index.ts";

async function importPlugin(p: string) {
    if (p.startsWith(".") || path.isAbsolute(p)) {
        return (await import(pathToFileURL(path.resolve(p)).href)).default;
    }

    try {
        const requireFromCwd = createRequire(
            path.join(process.cwd(), "index.js")
        );
        const resolved = requireFromCwd.resolve(p);
        return (await import(pathToFileURL(resolved).href)).default;
    } catch {
        try {
            const requireFromModule = createRequire(import.meta.url);
            const resolved = requireFromModule.resolve(p);
            return (await import(pathToFileURL(resolved).href)).default;
        } catch {
            return (await import(p)).default;
        }
    }
}

export async function runDirectory(
    pluginsArgs: string[],
    buildOnly: boolean,
    env: Record<string, string>,
    end: (code: number) => void
) {
    await Promise.all(
        pluginsArgs.map(async (p) =>
            plugin.register("build", await importPlugin(p))
        )
    );

    const result = await bundle();

    if (result.Warnings?.length) {
        console.warn("Warnings:", result.Warnings);
    }

    if (result.Errors?.length) {
        console.error("Errors:", result.Errors);
        end(1);
    } else if (!buildOnly) {
        run({ env });
    } else {
        console.log("Build complete.");
        end(0);
    }
}
