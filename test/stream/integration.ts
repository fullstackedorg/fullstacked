import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";

suite("stream - integration", () => {
    let browser: Browser;

    before(async () => {
        browser = await createBrowser("test/stream/sample");
    });

    test("stream", { timeout: 1000 * 3 }, async () => {
        const result = await bundle.bundle(Node, "test/stream/sample/read/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage(`http://localhost:${browser.webview.port}/read/`);

        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const streamed = await page.getTextContent("body");
            assert.deepEqual(streamed, "123");
        }

        await test();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await test();
    });

    test("streamWrite", { timeout: 1000 * 3 }, async () => {
        const result = await bundle.bundle(Node, "test/stream/sample/write/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage(`http://localhost:${browser.webview.port}/write/`);

        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const streamed = await page.getTextContent("body");
            assert.deepEqual(streamed, "123");
        }

        await test();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await test();
    });

    after(() => browser.end());
});
