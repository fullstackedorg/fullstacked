import { after, before, suite, test } from "node:test";
import { createWebView } from "../../platform/node/src/webview.ts";
import core from "../core.ts";
import { createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";
import assert from "node:assert";
import fs from "node:fs";
import { cleanupBundledFiles, getPixelColorRGB } from "./utils.ts";

suite("bundle - integration", () => {
    let webview: Awaited<ReturnType<typeof createWebView>>,
        browser: Awaited<ReturnType<typeof createBrowser>>,
        page: Awaited<ReturnType<(typeof browser)["createPage"]>>;

    before(async () => {
        cleanupBundledFiles("test/bundle/samples");
        webview = await createWebView(core.instance, "test/bundle/samples");
        browser = await createBrowser();
        page = await browser.createPage();
    });

    test("basic (fs)", async () => {
        await bundle.bundle(Node, "test/bundle/samples/basic/index.ts");
        await page.page.goto("http://localhost:9000/basic/");
        const text = await page.getTextContent("pre");
        assert.deepEqual(
            text,
            fs.readFileSync("test/bundle/samples/basic/test.md", {
                encoding: "utf-8"
            })
        );
    });

    test("css", async () => {
        await bundle.bundle(Node, "test/bundle/samples/css/index.ts");
        await page.page.goto("http://localhost:9000/css/");
        assert.deepEqual(
            await getPixelColorRGB(page.page, {
                x: 0,
                y: 0
            }),
            [255, 0, 0]
        );
    });

    after(() => {
        webview.close();
        return browser.browser.close();
    });
});
