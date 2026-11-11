// Loads a plugin from its file: in a worker when it may run there, so its
// work (a build plugin compiling CSS, say) never stalls the page, otherwise
// on the page.
//
// The worker is a bundle of a small entry written next to the plugin: it
// imports the plugin and calls serveInWorker, which registers it from the
// worker (the worker shares the page's context and opens its own plugin
// stream, see core/internal/plugin) or tells the page to take it.
import { PluginTypeBuild } from "../@types/index.ts";
import { bundleFile } from "../bundle/index.ts";
import fs from "../fs/index.ts";
import path from "../path/index.ts";
import os from "../os/index.ts";
import { Worker } from "../worker_threads/index.ts";
import { isWorker } from "../bridge/isWorker.ts";
import { register, type PluginRegistry } from "./index.ts";

export type LoadedPlugin = {
    // true when the plugin runs in a worker
    worker: boolean;
    unregister: () => Promise<void>;
};

// the bundle errors (esbuild messages) of a plugin that didn't build
export class PluginBundleError extends Error {
    errors: any[];
    constructor(file: string, errors: any[]) {
        super(`bundling plugin ${file} failed`);
        this.errors = errors;
    }
}

type WorkerAnswer =
    | { plugin: "registered" }
    | { plugin: "page" }
    | { plugin: "error"; message: string };

// a worker that never answers: the page takes the plugin
const WORKER_TIMEOUT_MS = 30 * 1000;

const isBuild = (type: string) => type === PluginTypeBuild;

/**
 * Bundles the plugin at `file` (a path, already resolved) and registers its
 * default export as a plugin of `type`. It runs in a worker when its
 * `data.worker` says so, or by default for build plugins; on the page
 * otherwise, and when workers aren't available (Node, or from a worker).
 */
export async function load<T extends keyof PluginRegistry>(
    type: T,
    file: string
): Promise<LoadedPlugin> {
    if (!isWorker && typeof globalThis.Worker === "function") {
        const inWorker = await loadInWorker(type, file);
        if (inWorker) return inWorker;
    }
    return loadOnPage(type, file);
}

/**
 * The worker's side of load(): registers the plugin `mod` (a module, its
 * default export or itself) from this worker, or hands it to the page when it
 * must run there.
 */
export async function serveInWorker(type: string, mod: any) {
    const plugin = mod?.default ?? mod;
    let answer: WorkerAnswer;
    try {
        if (plugin?.data?.worker ?? isBuild(type)) {
            await register(type as keyof PluginRegistry, plugin);
            answer = { plugin: "registered" };
        } else {
            answer = { plugin: "page" };
        }
    } catch (e: any) {
        answer = { plugin: "error", message: e?.message ?? String(e) };
    }
    globalThis.postMessage(answer);
}

// the URL a page loads a file of the context with (a module, a worker)
function fileUrl(file: string) {
    let url = path.resolve(process.cwd(), file);
    if (os.platform() === "win32") {
        url = url.replaceAll("\\", "/");
        if (url.at(1) === ":") url = url.slice(2);
    }
    return `${url}?t=${Date.now()}`;
}

async function bundle(file: string) {
    const result = await bundleFile(file);
    if (result.Errors?.length) {
        throw new PluginBundleError(file, result.Errors);
    }
    const output = result.OutputFiles?.at(0);
    if (!output) {
        throw new Error(`bundling plugin ${file} produced no output file`);
    }
    return output;
}

const remove = (file: string) => fs.promises.rm(file).catch(() => {});

async function loadOnPage(type: string, file: string): Promise<LoadedPlugin> {
    const output = await bundle(file);
    let mod: any;
    try {
        mod = await import(fileUrl(output));
    } finally {
        await remove(output);
    }
    const registered = await register(
        type as keyof PluginRegistry,
        mod.default ?? mod
    );
    return { worker: false, unregister: registered.unregister };
}

// null: the plugin goes on the page (it asked for it, or the worker failed)
async function loadInWorker(
    type: string,
    file: string
): Promise<LoadedPlugin | null> {
    const dir = path.dirname(file);
    const base = path.basename(file);
    // next to the plugin: it resolves its files from where it is
    const entry = path.join(dir, `.${base}.${Date.now()}.plugin-worker.ts`);
    await fs.promises.writeFile(
        entry,
        [
            `import { serveInWorker } from "fullstacked/plugin";`,
            `import * as mod from ${JSON.stringify("./" + base)};`,
            `serveInWorker(${JSON.stringify(type)}, mod);`,
            ""
        ].join("\n")
    );

    let output: string;
    try {
        output = await bundle(entry);
    } finally {
        await remove(entry);
    }

    const worker = new Worker(fileUrl(output));
    let answer: WorkerAnswer;
    try {
        answer = await new Promise<WorkerAnswer>((resolve) => {
            const timeout = setTimeout(
                () =>
                    resolve({
                        plugin: "error",
                        message: `no answer after ${WORKER_TIMEOUT_MS / 1000}s`
                    }),
                WORKER_TIMEOUT_MS
            );
            const done = (a: WorkerAnswer) => {
                clearTimeout(timeout);
                resolve(a);
            };
            worker.on("message", (e: MessageEvent) => {
                if (e.data?.plugin) done(e.data);
            });
            worker.on("error", (e: any) =>
                done({ plugin: "error", message: e?.message ?? String(e) })
            );
        });
    } finally {
        // the worker loaded it, or won't
        await remove(output);
    }

    if (answer.plugin !== "registered") {
        await worker.terminate();
        if (answer.plugin === "error") {
            console.warn(
                `[plugin] ${base} could not run in a worker (${answer.message}), loading it on the page`
            );
        }
        return null;
    }

    // a worker that dies takes its plugin with it: terminating closes its
    // plugin stream, the core drops the plugin and fails its waiting calls
    let ended: Promise<void> | null = null;
    const end = () => (ended ??= worker.terminate());
    worker.on("error", end);

    return { worker: true, unregister: end };
}
