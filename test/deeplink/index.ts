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
    test("a deeplink without plugin waits for the next deeplink plugin", async (t) => {
        assert.strictEqual(await plugin.deeplink(link + "-1"), 0);
        assert.strictEqual(
            await plugin.deeplink(link + "-2", globalThis.bridge.ctxId),
            0
        );

        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        // a failed test leaves no plugin to the next ones
        t.after(registered.unregister);
        assert.deepStrictEqual(await received(2), [link + "-1", link + "-2"]);
    });

    test("plugin.deeplink calls the deeplink plugin of this context", async (t) => {
        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        t.after(registered.unregister);
        assert.strictEqual(await plugin.deeplink(link), 1);
        assert.deepStrictEqual(await received(1), [link]);
    });

    test("plugin.deeplink can target a context by id", async (t) => {
        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        t.after(registered.unregister);
        assert.strictEqual(
            await plugin.deeplink(link, globalThis.bridge.ctxId),
            1
        );
        assert.deepStrictEqual(await received(1), [link]);
    });

    test("other plugin types neither receive nor consume deeplinks", async (t) => {
        const gitAuth = await plugin.register("git-auth", {
            callback: () => assert.fail("git-auth plugin called by a deeplink")
        });
        try {
            assert.strictEqual(await plugin.deeplink(link), 0);
        } finally {
            await gitAuth.unregister();
        }

        const { callback, received } = collect();
        const registered = await plugin.register("deeplink", { callback });
        t.after(registered.unregister);
        assert.deepStrictEqual(await received(1), [link]);
    });
});
