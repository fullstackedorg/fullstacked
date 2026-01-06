import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";
import { startServer } from "./server.ts";

suite("net - integration", () => {
    let browser: Browser, server: Worker;

    before(async () => {
        server = await startServer();
        browser = await createBrowser("test/net/sample");
    });

    test("socket", async () => {
        const result = await bundle.bundle(Node, "test/net/sample/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage();

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
    });

    after(() => {
        server.terminate();
        browser.end();
    });
});
