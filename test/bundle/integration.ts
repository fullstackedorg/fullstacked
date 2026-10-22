import test, { after, before, suite, afterEach } from "node:test";
import { type Browser, createBrowser, launchBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { cleanup } from "./common.ts";

suite("bundle - integration", () => {
    before(cleanup);
    afterEach(cleanup);

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

    after(() => browsers.forEach((b) => b.end()));
});

suite("bundle - browser-only", () => {
    before(cleanup);
    afterEach(cleanup);

    test("browser-only entrypoint served via basic static http server", async (t) => {
        // 1. Bundle using the fullstacked bundle function
        await bundle.bundle("test/bundle/samples/browser-only/index.ts");

        // 2. Start a basic static file serving http server with the bundled out dir as the root
        const outDir = path.resolve("test/bundle/samples/browser-only/out");
        const server = http.createServer((req, res) => {
            const urlPath = req.url === "/" ? "/index.html" : req.url;
            const filePath = path.join(outDir, urlPath!);

            // Check path traversal
            if (!filePath.startsWith(outDir)) {
                res.writeHead(403);
                res.end("Forbidden");
                return;
            }

            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath);
                let contentType = "text/plain";
                if (ext === ".html") contentType = "text/html";
                else if (ext === ".js") contentType = "application/javascript";
                else if (ext === ".css") contentType = "text/css";

                res.writeHead(200, { "Content-Type": contentType });
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404);
                res.end("Not Found");
            }
        });

        const port = await new Promise<number>((resolve) => {
            server.listen(0, () => {
                resolve((server.address() as any).port);
            });
        });

        // 3. Launch puppeteer to load the page and check execution
        const browser = await launchBrowser({
            headless: !process.argv.includes("--show-browser"),
            devtools: process.argv.includes("--show-browser")
        }).catch((e) => {
            server.close();
            throw e;
        });
        t.after(async () => {
            await browser.close();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });

        const page = await browser.newPage();

        // Listen for browser page errors to ensure no shim/script crashes execution
        // puppeteer types what a page throws as unknown: not always an Error
        const errors: unknown[] = [];
        page.on("pageerror", (err) => {
            errors.push(err);
        });

        await page.goto(`http://localhost:${port}`);

        // Wait a bit or wait for body text to contain "testing"
        await page.waitForFunction(() =>
            document.body.textContent?.includes("testing")
        );

        const textContent = await page.evaluate(
            () => document.body.textContent
        );
        assert.ok(
            textContent?.includes("testing"),
            "Page body should contain 'testing'"
        );

        // Make sure there were no uncaught errors during page execution
        assert.deepEqual(errors, [], "Should have no uncaught page errors");
    });
});
