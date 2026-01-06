import test, { before, suite, after } from "node:test";
import { Browser, createBrowser } from "../browser.ts";
import assert from "node:assert";
import { HTTPResponse } from "puppeteer";
import fs from "../../core/internal/bundle/lib/fs/index.ts";

suite("static-file - integration", () => {
    let browser: Browser;

    before(async () => {
        browser = await createBrowser("test/static-file/sample");
    });

    test("index.html", async () => {
        const page = await browser.createPage();
        const title = await page.getTextContent("title");
        const bodyH1 = await page.getTextContent("h1");
        assert.deepEqual(title.toString(), "Test");
        assert.deepEqual(bodyH1.toString(), "Test");
        await page.page.close();
    });

    test("script", { timeout: 3000 }, async () => {
        const scriptContent = await new Promise<Uint8Array>(async (resolve) => {
            const page = await browser.createPage(null);
            const resCb = async (res: HTTPResponse) => {
                if (res.url().endsWith("/index.ts")) {
                    resolve(await res.content());
                    page.page.off("response", resCb);
                }
            };

            page.page.on("response", resCb);
            page.page.goto(`http://localhost:${browser.webview.port}/script/`);
        });

        assert.deepEqual(
            scriptContent,
            fs.readFileSync("test/static-file/sample/_index.ts.js")
        );
    });

    after(() => browser.end());
});
