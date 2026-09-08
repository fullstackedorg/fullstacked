import fs from "../fs/index.ts";

const CONFIG_FILE = "/.git/config.json";

export async function loadConfig(): Promise<Record<string, any>> {
    try {
        const content = await fs.promises.readFile(CONFIG_FILE, {
            encoding: "utf-8"
        });
        return JSON.parse(content);
    } catch (e) {
        return {};
    }
}

export async function saveConfig(config: Record<string, any>): Promise<void> {
    try {
        await fs.promises.mkdir("/.git");
    } catch (e) {}
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function getConfig(key?: string): Promise<any> {
    const config = await loadConfig();
    if (!key) return config;
    return config?.[key]?.toString();
}

export async function setConfig(key: string, value: string): Promise<void> {
    const current = await loadConfig();
    current[key] = value.toString();
    await saveConfig(current);
}

export async function deleteConfig(key: string): Promise<void> {
    const current = await loadConfig();
    delete current[key];
    await saveConfig(current);
}

const config = {
    loadConfig,
    saveConfig,
    getConfig,
    setConfig,
    deleteConfig
};

export default config;
