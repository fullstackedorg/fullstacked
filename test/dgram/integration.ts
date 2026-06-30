import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { startServer } from "./server.ts";

suite("dgram - integration", () => {
    let browser: Browser, server: Worker;

    before(async () => {
        server = await startServer();
        browser = await createBrowser("test/dgram/sample");
    });

    test("socket", async () => {
        const result = await bundle.bundle("test/dgram/sample/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage();

        const testFlow = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const streamed = await page.getTextContent("body");
            assert.deepEqual(streamed, "123ACK");
        };

        await testFlow();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await testFlow();
    });

    after(() => {
        server.terminate();
        browser.end();
    });
});
