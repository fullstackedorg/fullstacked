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

type CommonPluginData = {
    name?: string;
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
let duplexStream: Duplex | null = null;
let eventEmitter: EventEmitter<{
    // pluginId, requestId, ...data
    "plugin-call": [number, number, ...any[]];

    // pluginId, requestId, errorMessage, ...result
    "plugin-response": [number, number, string | null, ...any[]];

    ready: [];
}> | null = null;

let connectionPromise: Promise<void> | null = null;

const te = new TextEncoder();

async function connect(): Promise<void> {
    if (duplexStream) {
        return;
    }

    const duplex = (await globalThis.fullstacked.bridge({
        mod: PluginModule,
        fn: StartPluginStream
    })) as Duplex;

    const emitter = duplex.eventEmitter() as EventEmitter<{
        "plugin-call": [number, number, ...any[]];
        "plugin-response": [number, number, string | null, ...any[]];
        ready: [];
    }>;

    const readyPromise = new Promise<void>((resolve) => {
        emitter.on("ready", function onReady() {
            emitter.off("ready", onReady);
            resolve();
        });
    });

    await duplex.open();

    await readyPromise;

    duplexStream = duplex;
    eventEmitter = emitter;

    eventEmitter.on(
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
                        result.forEach(({ outputName, contents }) => {
                            contents =
                                typeof contents === "string"
                                    ? te.encode(contents)
                                    : contents;
                            remappedResult.push(outputName, contents);
                        });
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
                eventEmitter!.writeEvent(
                    "plugin-response",
                    pluginId,
                    requestId,
                    errorMsg,
                    ...result
                );
            } else {
                eventEmitter!.writeEvent(
                    "plugin-response",
                    pluginId,
                    requestId,
                    errorMsg,
                    result
                );
            }
        }
    );
}

export async function register<T extends keyof PluginRegistry>(
    type: T,
    plugin: PluginRegistry[T]
) {
    if (!connectionPromise) {
        connectionPromise = connect();
    }
    await connectionPromise;

    const { name, ...pluginData } = plugin.data || {};

    const id = await globalThis.fullstacked.bridge({
        mod: PluginModule,
        fn: Register,
        data: [type, name || "plugin-" + type, pluginData]
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

const plugin = {
    register,
    deeplink
};

export default plugin;
