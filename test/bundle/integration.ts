import { after, before, suite, test } from "node:test";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";
import assert from "node:assert";
import fs from "node:fs";

suite("bundle - integration", () => {
    let browser: Browser;

    before(async () => {
        browser = await createBrowser("test/bundle/samples");
    });

    test("basic (fs)", async () => {
        await bundle.bundle(Node, "test/bundle/samples/basic/index.ts");
        const page = await browser.createPage(
            `http://localhost:${browser.webview.port}/basic/`
        );
        const text = await page.getTextContent("pre");
        assert.deepEqual(
            text,
            fs.readFileSync("test/bundle/samples/basic/test.md", {
                encoding: "utf-8"
            })
        );
        await page.page.close();
    });

    test("css", async () => {
        await bundle.bundle(Node, "test/bundle/samples/css/index.ts");
        const page = await browser.createPage(
            `http://localhost:${browser.webview.port}/css/`
        );
        assert.deepEqual(
            await page.getPixelColorRGB({
                x: 0,
                y: 0
            }),
            [255, 0, 0]
        );
        await page.page.close();
    });

    after(() => browser.end());
});
