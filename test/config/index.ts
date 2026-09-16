import test, { suite, after } from "node:test";
import assert from "node:assert";
import * as config from "../../core/internal/bundle/lib/config/index.ts";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

suite("config - e2e", () => {
    const gitDir = nodePath.join(process.cwd(), ".git");
    const configFile = nodePath.join(gitDir, "config.json");

    // Clean up any test config file afterwards
    after(() => {
        try {
            if (nodeFs.existsSync(configFile)) {
                nodeFs.unlinkSync(configFile);
            }
        } catch {}
    });

    test("get non-existent key returns undefined", async () => {
        const val = await config.get("nonExistentKey_" + Date.now());
        assert.strictEqual(val, undefined);
    });

    test("reject non-string values", async () => {
        const key = "rejectKey_" + Date.now();
        await assert.rejects(
            async () => {
                await config.set(key, 123 as any);
            },
            {
                name: "TypeError",
                message: "Config value must be a string"
            }
        );
    });

    test("set and get string value", async () => {
        const key = "testKey_" + Date.now();
        const value = "testValue";

        await config.set(key, value);

        const retrieved = await config.get(key);
        assert.strictEqual(retrieved, value);

        // Verify .git/config.json exists on disk
        assert.ok(nodeFs.existsSync(configFile), ".git/config.json must exist");

        const raw = JSON.parse(nodeFs.readFileSync(configFile, "utf-8"));
        assert.strictEqual(raw[key], value);
    });

    test("list returns all keys", async () => {
        const key1 = "listKey1_" + Date.now();
        const key2 = "listKey2_" + Date.now();

        await config.set(key1, "val1");
        await config.set(key2, "val2");

        const all = await config.list();
        assert.ok(all && typeof all === "object");
        assert.strictEqual(all[key1], "val1");
        assert.strictEqual(all[key2], "val2");
    });

    test("delete removes key", async () => {
        const key = "toDelete_" + Date.now();
        await config.set(key, "deleteMe");

        let val = await config.get(key);
        assert.strictEqual(val, "deleteMe");

        await config.del(key);

        val = await config.get(key);
        assert.strictEqual(val, undefined);

        const raw = JSON.parse(nodeFs.readFileSync(configFile, "utf-8"));
        assert.strictEqual(raw[key], undefined);
    });

    test("delete alias delete works", async () => {
        const key = "toDeleteAlias_" + Date.now();
        await config.set(key, "deleteMeAlias");

        await config.delete(key);

        const val = await config.get(key);
        assert.strictEqual(val, undefined);
    });

    test("aliases getConfig, setConfig, listConfig, deleteConfig", async () => {
        const key = "aliasKey_" + Date.now();
        await config.setConfig(key, "aliasVal");

        const val = await config.getConfig(key);
        assert.strictEqual(val, "aliasVal");

        const list = await config.listConfig();
        assert.strictEqual(list[key], "aliasVal");

        await config.deleteConfig(key);
        const afterDel = await config.getConfig(key);
        assert.strictEqual(afterDel, undefined);
    });
});
