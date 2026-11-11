import {
    Core,
    Plugin as PluginModule,
    type GitAuth,
    PluginTypeGitAuth,
    PluginTypeBuild,
    PluginTypeDeepLink
} from "../@types/index.ts";
import { DeepLink } from "../@types/router.ts";
import {
    StartPluginStream,
    Register,
    Unregister,
    Ready
} from "../@types/plugin.ts";
import type { Duplex } from "../bridge/duplex.ts";
import type { EventEmitter } from "../bridge/eventEmitter.ts";
import type { PluginBuildData, PluginParams } from "../@types/bundle.ts";
import { isWorker } from "../bridge/isWorker.ts";

type CommonPluginData = {
    name?: string;
    /**
     * Where `load()` runs the plugin: `true` in a worker, `false` on the page.
     * By default, build plugins run in a worker (their work doesn't stall the
     * page) and the others on the page (they may show UI, like a git-auth
     * prompt). `register()` always registers in the runtime that calls it.
     */
    worker?: boolean;
};

export type PluginRegistry = {
    [PluginTypeGitAuth]: {
        data?: CommonPluginData;
        callback: (
            host: string
        ) => Promise<Partial<GitAuth>> | Partial<GitAuth>;
    };
    [PluginTypeBuild]: {
        data?: CommonPluginData & PluginBuildData;
        callback: (
            params: PluginParams
        ) => Promise<{ outputName: string; contents: string | Uint8Array }[]>;
    };
    // Called with the full URL (fullstacked://...) when the platform receives
    // a deeplink, or when deeplink(url) is called in this context.
    [PluginTypeDeepLink]: {
        data?: CommonPluginData;
        callback: (url: string) => Promise<void> | void;
    };
};

export interface JSPlugin {
    type: string;
    callback: (...args: any[]) => Promise<any | any[]> | any | any[];
}

if (!globalThis.fullstacked) {
    globalThis.fullstacked = {};
}
if (!globalThis.fullstacked.plugins) {
    globalThis.fullstacked.plugins = new Map<number, JSPlugin>();
}
type PluginEvents = {
    // pluginId, requestId, ...data
    "plugin-call": [number, number, ...any[]];

    // pluginId, requestId, errorMessage, ...result
    "plugin-response": [number, number, string | null, ...any[]];

    ready: [];
};

type PluginConnection = {
    duplex: Duplex;
    emitter: EventEmitter<PluginEvents>;
};

const te = new TextEncoder();

// One plugin stream per runtime (the page, or a worker), shared by the
// bundles it loaded: the core replaces every plugin of the context when a
// page opens a stream (a reload), so a second stream of the page would drop
// the plugins of the first.
function connection(): Promise<PluginConnection> {
    if (!globalThis.fullstacked.pluginConnection) {
        globalThis.fullstacked.pluginConnection = connect();
        globalThis.fullstacked.pluginConnection.catch(() => {
            globalThis.fullstacked.pluginConnection = null;
        });
    }
    return globalThis.fullstacked.pluginConnection;
}

async function connect(): Promise<PluginConnection> {
    const duplex = (await globalThis.fullstacked.bridge({
        mod: PluginModule,
        fn: StartPluginStream,
        // a worker's stream keeps the plugins of the page and other workers
        data: isWorker ? [true] : undefined
    })) as Duplex;

    const emitter = duplex.eventEmitter() as EventEmitter<PluginEvents>;

    const readyPromise = new Promise<void>((resolve) => {
        emitter.on("ready", function onReady() {
            emitter.off("ready", onReady);
            resolve();
        });
    });

    await duplex.open();

    await readyPromise;

    emitter.on(
        "plugin-call",
        async (pluginId: number, requestId: number, ...args: any[]) => {
            let result: any = null;
            let errorMsg: string | null = null;
            try {
                const registeredPlugin =
                    globalThis.fullstacked.plugins.get(pluginId);

                if (registeredPlugin) {
                    result = await registeredPlugin.callback(...args);

                    if (registeredPlugin.type === PluginTypeBuild) {
                        const remappedResult: (string | Uint8Array)[] = [];
                        type BuildOutput = {
                            outputName: string;
                            contents: string | Uint8Array;
                        };
                        result.forEach(
                            ({ outputName, contents }: BuildOutput) => {
                                contents =
                                    typeof contents === "string"
                                        ? te.encode(contents)
                                        : contents;
                                remappedResult.push(outputName, contents);
                            }
                        );
                        result = remappedResult;
                    }
                } else {
                    throw new Error(
                        `No registered plugin found for id: ${pluginId}`
                    );
                }
            } catch (err: any) {
                errorMsg = err.message || String(err);
            }

            if (Array.isArray(result)) {
                emitter.writeEvent(
                    "plugin-response",
                    pluginId,
                    requestId,
                    errorMsg,
                    ...result
                );
            } else {
                emitter.writeEvent(
                    "plugin-response",
                    pluginId,
                    requestId,
                    errorMsg,
                    result
                );
            }
        }
    );

    return { duplex, emitter };
}

export async function register<T extends keyof PluginRegistry>(
    type: T,
    plugin: PluginRegistry[T]
) {
    const { duplex } = await connection();

    const { name, worker: _, ...pluginData } = plugin.data || {};

    const id = await globalThis.fullstacked.bridge({
        mod: PluginModule,
        fn: Register,
        data: [type, name || "plugin-" + type, pluginData, duplex.id]
    });

    globalThis.fullstacked.plugins.set(id, {
        type: type as string,
        callback: plugin.callback
    });

    // the plugin can now receive calls: the core delivers what waited for it
    // (e.g. the deeplink that launched the app)
    await globalThis.fullstacked.bridge({
        mod: PluginModule,
        fn: Ready,
        data: [id]
    });

    return {
        unregister: async () => {
            globalThis.fullstacked.plugins.delete(id);
            await globalThis.fullstacked.bridge({
                mod: PluginModule,
                fn: Unregister,
                data: [id]
            });
        }
    };
}

/**
 * Triggers the deeplink plugins registered in context `ctx` (this context by
 * default) with `url`, as platforms do for every context when a deeplink comes
 * from the outside. Resolves with the number of deeplink plugins called; with
 * none registered yet, the core keeps `url` for the next one (at most 8, for
 * 60 seconds).
 */
export async function deeplink(url: string, ctx?: number): Promise<number> {
    return (await globalThis.fullstacked.bridge({
        mod: Core,
        fn: DeepLink,
        data: [url],
        ctx
    })) as number;
}

export { load, serveInWorker, PluginBundleError } from "./load.ts";
export type { LoadedPlugin } from "./load.ts";
import { load } from "./load.ts";

const plugin = {
    register,
    load,
    deeplink
};

export default plugin;
