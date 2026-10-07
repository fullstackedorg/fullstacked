import test, { suite } from "node:test";
import assert from "node:assert";
import plugin from "../../core/internal/bundle/lib/plugin/index.ts";

const link = "fullstacked:///command/exec%20example.com%20-y";

function collect() {
    const urls: string[] = [];
    let wake = () => {};
    return {
        urls,
        callback: (url: string) => {
            urls.push(url);
            wake();
        },
        // resolves once `count` urls were received
        received: (count: number) =>
            new Promise<string[]>((resolve) => {
                const check = () => urls.length >= count && resolve(urls);
                wake = check;
                check();
            })
    };
}

suite("deeplink - e2e", () => {
    test("a deeplink without plugin waits for the next deeplink plugin", async () => {
        assert.strictEqual(await plugin.deeplink(link + "-1"), 0);
        assert.strictEqual(
            await plugin.deeplink(link + "-2", globalThis.bridge.ctxId),
            0
        );

        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        assert.deepStrictEqual(await received(2), [link + "-1", link + "-2"]);
        await registered.unregister();
    });

    test("plugin.deeplink calls the deeplink plugin of this context", async () => {
        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        assert.strictEqual(await plugin.deeplink(link), 1);
        assert.deepStrictEqual(await received(1), [link]);
        await registered.unregister();
    });

    test("plugin.deeplink can target a context by id", async () => {
        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        assert.strictEqual(
            await plugin.deeplink(link, globalThis.bridge.ctxId),
            1
        );
        assert.deepStrictEqual(await received(1), [link]);
        await registered.unregister();
    });

    test("other plugin types neither receive nor consume deeplinks", async () => {
        const gitAuth = await plugin.register("git-auth", {
            callback: () => assert.fail("git-auth plugin called by a deeplink")
        });
        assert.strictEqual(await plugin.deeplink(link), 0);
        await gitAuth.unregister();

        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        assert.deepStrictEqual(await received(1), [link]);
        await registered.unregister();
    });
});
