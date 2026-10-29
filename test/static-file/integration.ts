import test, { before, suite, after } from "node:test";
import { type Browser, createBrowser } from "../browser.ts";
import assert from "node:assert";
import http from "node:http";
import { HTTPResponse } from "puppeteer";
import fs from "../../core/internal/bundle/lib/fs/index.ts";

// the request path as is, a browser would resolve the ../ before sending it
function getStatus(port: number, path: string) {
    return new Promise<number>((resolve, reject) => {
        http.get({ host: "localhost", port, path }, (res) => {
            res.resume();
            resolve(res.statusCode);
        }).on("error", reject);
    });
}

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

    test("script", { timeout: 5000 }, async () => {
        const scriptContent = await new Promise<Uint8Array>(async (resolve) => {
            const page = await browser.createPage(null);
            const resCb = async (res: HTTPResponse) => {
                if (res.url().endsWith("index.js")) {
                    resolve(await res.content());
                    page.page.off("response", resCb);
                }
            };

            page.page.on("response", resCb);
            page.page.goto(`http://localhost:${browser.webview.port}/script/`);
        });

        assert.deepEqual(
            scriptContent,
            fs.readFileSync("test/static-file/sample/script/index.js")
        );
    });

    test("outside of the project", async () => {
        const port = browser.webview.port;
        assert.equal(await getStatus(port, "/script%2F..%2Findex.html"), 200);
        // test/static-file/e2e.ts is right above the project
        for (const path of [
            "/../e2e.ts",
            "/..%2Fe2e.ts",
            "/%2E%2E%2Fe2e.ts",
            "/..%5Ce2e.ts",
            "/script%2F..%2F..%2Fe2e.ts"
        ]) {
            assert.equal(await getStatus(port, path), 404, path);
        }
    });

    after(() => browser.end());
});
