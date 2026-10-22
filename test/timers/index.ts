import test, { suite } from "node:test";
import assert from "node:assert";

// mean delay of a setImmediate, chained
async function immediateDelayMs(setImmediate: (cb: () => void) => any) {
    const n = 200;
    const start = performance.now();
    for (let i = 0; i < n; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return (performance.now() - start) / n;
}

suite("timers", () => {
    // it was replaced by a timer of 0 (1 ms in Node) once anything imported
    // "timers" in an app run by fullstacked --file
    test("keeps the host's setImmediate", async () => {
        const native = globalThis.setImmediate;
        const timers =
            await import("../../core/internal/bundle/lib/timers/index.ts");
        assert.equal(globalThis.setImmediate, native);
        const delay = await immediateDelayMs(timers.setImmediate);
        assert.ok(delay < 0.5, `setImmediate took ${delay}ms`);
    });

    // pages and workers have none: a message to a channel, not a timer
    test("setImmediate where there is none", async () => {
        const native = {
            setImmediate: globalThis.setImmediate,
            clearImmediate: globalThis.clearImmediate
        };
        // the unref'd channel does not keep the process alive meanwhile
        const keepAlive = setInterval(() => {}, 1000);
        delete (globalThis as any).setImmediate;
        delete (globalThis as any).clearImmediate;
        try {
            const timers =
                await import("../../core/internal/bundle/lib/timers/index.ts?polyfill");
            assert.notEqual(timers.setImmediate, native.setImmediate);

            const order: string[] = [];
            await new Promise<void>((resolve) => {
                timers.setImmediate(
                    (a: string, b: string) => order.push(a + b),
                    "a",
                    "1"
                );
                const cleared = timers.setImmediate(() => order.push("x"));
                timers.setImmediate(() => order.push("b"));
                timers.clearImmediate(cleared);
                timers.setImmediate(resolve);
            });
            assert.deepEqual(order, ["a1", "b"]);

            const delay = await immediateDelayMs(timers.setImmediate);
            assert.ok(delay < 0.5, `setImmediate took ${delay}ms`);
        } finally {
            Object.assign(globalThis, native);
            clearInterval(keepAlive);
        }
    });

    test("timers/promises setImmediate", async () => {
        const { setImmediate } =
            await import("../../core/internal/bundle/lib/timers/promises.ts");
        assert.equal(await setImmediate("value"), "value");
    });
});
