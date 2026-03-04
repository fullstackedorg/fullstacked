import test, { after, suite } from "node:test";
import assert from "node:assert";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";

suite("stream - integration", () => {
    let browsers: Browser[] = [];

    test("stream", { timeout: 1000 * 3 }, async () => {
        const browser = await createBrowser("test/stream/sample/read");
        browsers.push(browser);

        const result = await bundle.bundle("test/stream/sample/read");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage(
            `http://localhost:${browser.webview.port}`
        );

        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const streamed = await page.getTextContent("body");
            assert.deepEqual(streamed, "123");
        };

        await test();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await test();
        await browser.end();
    });

    test("streamWrite", { timeout: 1000 * 3 }, async () => {
        const browser = await createBrowser("test/stream/sample/write");
        browsers.push(browser);

        const result = await bundle.bundle("test/stream/sample/write");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage(
            `http://localhost:${browser.webview.port}`
        );

        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const streamed = await page.getTextContent("body");
            assert.deepEqual(streamed, "123");
        };

        await test();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await test();
        await browser.end();
    });

    after(() => browsers.forEach((b) => b.end()));
});
