import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";

suite("events - integration", () => {
    let browser: Browser;

    before(async () => {
        browser = await createBrowser("test/events/sample");
    });

    test("emit", async () => {
        const result = await bundle.bundle("test/events/sample/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage();
        await page.page.waitForFunction(
            'document.body.classList.contains("done")'
        );
        const received = await page.getTextContent("pre");
        assert.deepEqual(
            received,
            `undefined false string 2 1,2,3 {"foo":"testing"} `
        );
    });

    after(() => browser.end());
});
