import { Config } from "../@types/index.ts";
import { Delete, Get, List, Set } from "../@types/config.ts";

export function get(key?: string): Promise<string | undefined> {
    if (!key) return Promise.resolve(undefined);
    return globalThis.fullstacked.bridge({
        mod: Config,
        fn: Get,
        data: [key]
    });
}

export function set(key: string, value: string): Promise<void> {
    if (typeof value !== "string") {
        return Promise.reject(new TypeError("Config value must be a string"));
    }
    return globalThis.fullstacked.bridge({
        mod: Config,
        fn: Set,
        data: [key, value]
    });
}

export function list(): Promise<Record<string, string>> {
    return globalThis.fullstacked.bridge({
        mod: Config,
        fn: List
    });
}

export function del(key: string): Promise<void> {
    if (!key) return Promise.resolve();
    return globalThis.fullstacked.bridge({
        mod: Config,
        fn: Delete,
        data: [key]
    });
}

export { del as delete };

export const getConfig = get;
export const setConfig = set;
export const listConfig = list;
export const deleteConfig = del;

const config = {
    get,
    set,
    list,
    delete: del,
    del,
    getConfig,
    setConfig,
    listConfig,
    deleteConfig
};

export default config;
