import test, { before, suite, after } from "node:test";
import { createBrowser } from "../browser.ts";
import { createWebView } from "../../platform/node/src/webview.ts";
import core from "../core.ts";
import assert from "node:assert";
import { HTTPResponse } from "puppeteer";
import fs from "../../core/internal/bundle/lib/fs/index.ts";

suite("static-file - integration", () => {
    let webview: Awaited<ReturnType<typeof createWebView>>,
        browser: Awaited<ReturnType<typeof createBrowser>>,
        page: Awaited<ReturnType<(typeof browser)["createPage"]>>;

    before(async () => {
        webview = await createWebView(core.instance, "test/static-file/sample");

        browser = await createBrowser();
        page = await browser.createPage();
    });

    test("index.html", async () => {
        await page.page.goto("http://localhost:9000");
        const title = await page.getTextContent("title");
        const bodyH1 = await page.getTextContent("h1");
        assert.deepEqual(title.toString(), "Test");
        assert.deepEqual(bodyH1.toString(), "Test");
    });

    test("script", { timeout: 10000000 }, async () => {
        const scriptContent = await new Promise<Uint8Array>((resolve) => {
            const resCb = async (res: HTTPResponse) => {
                if (res.url().endsWith("/index.ts")) {
                    resolve(await res.content());
                    page.page.off("response", resCb);
                }
            };

            page.page.on("response", resCb);
            page.page.goto("http://localhost:9000/script");
        });

        assert.deepEqual(
            scriptContent,
            fs.readFileSync("test/static-file/sample/_index.ts.js")
        );
    });

    after(() => {
        webview.close();
        return browser.browser.close();
    });
});
