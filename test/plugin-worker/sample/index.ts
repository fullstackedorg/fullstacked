import fs from "fs";
import plugin from "fullstacked/plugin";
import bundle from "fullstacked/bundle";

// Loads build plugins with plugin.load and bundles app/ with each. The page
// keeps a deeplink plugin of its own all along. test/plugin-worker reads the
// results in the body.

const results: Record<string, any> = {};

const deeplinks: string[] = [];
await plugin.register("deeplink", {
    callback: (url) => {
        deeplinks.push(url);
    }
});

async function deeplinkReaches(url: string) {
    const called = await plugin.deeplink(url);
    for (let i = 0; i < 100 && !deeplinks.includes(url); i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
    return called === 1 && deeplinks.includes(url);
}

// the longest the page went without running a timer while bundling
async function bundleApp() {
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
    }, 10);
    try {
        const result = await bundle.bundle("app");
        const output = result.Errors?.length
            ? null
            : fs.readFileSync("app/out/busy.txt", "utf8");
        return {
            errors: (result.Errors ?? []).map((e: any) => e.Text),
            output,
            longest: Math.round(longest)
        };
    } finally {
        clearInterval(timer);
    }
}

async function run() {
    const busy = await plugin.load("build", "busy.ts");
    results.busy = { worker: busy.worker, ...(await bundleApp()) };
    results.deeplinkWithWorker = await deeplinkReaches("fullstacked:///a");
    await busy.unregister();
    results.deeplinkAfterWorker = await deeplinkReaches("fullstacked:///b");

    const page = await plugin.load("build", "page.ts");
    results.page = { worker: page.worker, ...(await bundleApp()) };
    await page.unregister();

    const crash = await plugin.load("build", "crash.ts");
    results.crash = { worker: crash.worker, ...(await bundleApp()) };
    await crash.unregister();
    results.deeplinkAfterCrash = await deeplinkReaches("fullstacked:///c");

    // nothing left of the plugins' temporary files
    results.leftovers = fs
        .readdirSync(".")
        .filter(
            (f: string) => f.includes("plugin-worker") || f.endsWith(".ts.js")
        );
}

try {
    await run();
} catch (e: any) {
    results.error = e?.stack ?? String(e);
}
document.body.innerText = JSON.stringify(results);
document.body.classList.add("done");
