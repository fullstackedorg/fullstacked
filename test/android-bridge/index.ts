import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { type Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { androidPage, startAndroidHost } from "./host.ts";

const sample = "test/android-bridge/sample";

const WASM = "0061736d";
// "ls\nc", the start of the .history the page read
const HISTORY = "6c730a63";

// The sync calls of workers on a host that reads no request body (Android):
// the page relays the worker's call, the worker reads its response with GET
// /sync/{key}. A worker took the response of the page's last sync call with
// the same id (the Tailwind build plugin got the bytes of the shell's
// .history for its lightningcss .wasm), or another worker's.
suite("android bridge - worker sync calls", () => {
    let browser: Browser;
    let host: Awaited<ReturnType<typeof startAndroidHost>>;

    before(async () => {
        assert.deepEqual(
            (await bundle.bundleFile(`${sample}/worker.ts`)).Errors,
            null
        );
        assert.deepEqual(
            (await bundle.bundle(`${sample}/index.ts`)).Errors,
            null
        );
        browser = await createBrowser(sample);
        host = await startAndroidHost(browser.webview.port);
    });

    const run = async (mode: "legacy" | "fixed", cases: string) => {
        const page = await browser.createPage(null);
        await page.page.evaluateOnNewDocument(androidPage, mode);
        await page.page.goto(`http://localhost:${host.port}/?cases=${cases}`);
        await page.page.waitForFunction(
            'document.body.classList.contains("done")',
            { timeout: 60000 }
        );
        const result = JSON.parse(await page.getTextContent("body"));
        await page.page.close();
        return result;
    };

    // the model reproduces the crossed read: the host before callSync and
    // relaySync kept the page's sync responses for GET /sync/{id}
    test("a host keeping the page's sync responses crosses the reads", async () => {
        const r = await run("legacy", "page");
        assert.equal(r.error, undefined);
        assert.equal(r.afterPage.head, HISTORY);
    });

    test("a worker reads its own file", async () => {
        const r = await run("fixed", "all");
        assert.equal(r.error, undefined);

        assert.deepEqual(r.afterPage, {
            file: "a.wasm",
            head: WASM,
            size: 64 * 1024,
            fill: 0xaa
        });

        const [a, b] = r.twoWorkers;
        assert.deepEqual(a, {
            file: "a.wasm",
            head: WASM,
            size: 64 * 1024,
            fill: 0xaa
        });
        assert.deepEqual(b, {
            file: "b.wasm",
            head: WASM,
            size: 64 * 1024,
            fill: 0xbb
        });
    });

    after(async () => {
        host?.close();
        if (browser) await browser.end();
    });
});
