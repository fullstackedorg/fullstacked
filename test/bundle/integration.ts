import { after, before, suite, test } from "node:test";
import { createWebView } from "../../platform/node/src/webview.ts";
import core from "../core.ts";
import { createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";
import assert from "node:assert";
import fs from "node:fs";

suite("bundle - integration", () => {
    let webview: Awaited<ReturnType<typeof createWebView>>,
        browser: Awaited<ReturnType<typeof createBrowser>>,
        page: Awaited<ReturnType<(typeof browser)["createPage"]>>;

    before(async () => {
        webview = await createWebView(core.instance, "test/bundle/sample");

        browser = await createBrowser();
        page = await browser.createPage();
    });

    test("fs", async () => {
        await bundle.bundle(Node, "test/bundle/sample/index.ts");
        await page.page.goto("http://localhost:9000");
        const text = await page.getTextContent("pre");
        assert.deepEqual(
            text,
            fs.readFileSync("test/bundle/sample/test.md", { encoding: "utf-8" })
        );
    });

    after(() => {
        webview.close();
        return browser.browser.close();
    });
});
