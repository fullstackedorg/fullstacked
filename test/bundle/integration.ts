import test, { after, before, suite, afterEach } from "node:test";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import assert from "node:assert";
import fs from "node:fs";
import { cleanup, tailwindcssBuilder } from "./common.ts";

suite("bundle - integration", () => {
    // before(cleanup);
    // afterEach(cleanup);

    let browsers: Browser[] = [];

    test("basic (fs)", async () => {
        const browser = await createBrowser("test/bundle/samples/basic");
        browsers.push(browser);

        await bundle.bundle("test/bundle/samples/basic/index.ts");

        const page = await browser.createPage();
        const text = await page.getTextContent("pre");
        assert.deepEqual(
            text,
            fs.readFileSync("test/bundle/samples/basic/test.md", {
                encoding: "utf-8"
            })
        );
        await page.page.close();
        await browser.end();
    });

    test("css", async () => {
        const browser = await createBrowser("test/bundle/samples/css");
        browsers.push(browser);

        await bundle.bundle("test/bundle/samples/css/index.ts");
        const page = await browser.createPage();
        assert.deepEqual(
            await page.getPixelColorRGB({
                x: 0,
                y: 0
            }),
            [255, 0, 0]
        );
        await page.page.close();
        await browser.end();
    });

    test("tailwindcss", async () => {
        const browser = await createBrowser("test/bundle/samples/tailwindcss");
        browsers.push(browser);

        const builder = await tailwindcssBuilder();

        await bundle.bundle("test/bundle/samples/tailwindcss/index.ts");
        const page = await browser.createPage();

        assert.deepEqual(
            await page.getPixelColorRGB({
                x: 0,
                y: 0
            }),
            [251, 44, 54]
        );
        await page.page.close();
        await browser.end();
        builder.end();
    });

    after(() => browsers.forEach((b) => b.end()));
});

suite("bundle - style builders - integration", () => {
    let browser: Browser;

    afterEach(() => {
        browser.end();
        cleanup();
    });

    before(cleanup);

    test("tailwindcss - build", async () => {
        fs.cpSync(
            "node_modules/oxide-wasm",
            "test/bundle/samples/tailwindcss/build/node_modules/oxide-wasm",
            {
                recursive: true
            }
        );
        fs.cpSync(
            "node_modules/lightningcss-wasm",
            "test/bundle/samples/tailwindcss/build/node_modules/lightningcss-wasm",
            {
                recursive: true
            }
        );
        fs.cpSync(
            "node_modules/tailwindcss",
            "test/bundle/samples/tailwindcss/build/node_modules/tailwindcss",
            {
                recursive: true
            }
        );

        await bundle.bundle("test/bundle/samples/tailwindcss/build/index.ts");

        browser = await createBrowser("test/bundle/samples/tailwindcss/build");
        const page = await browser.createPage();

        await page.page.waitForFunction(
            'document.body.classList.contains("done")'
        );

        assert.deepEqual(
            await page.getPixelColorRGB({
                x: 0,
                y: 0
            }),
            [251, 44, 54]
        );
    });
});
