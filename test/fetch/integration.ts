import test, { after, before, suite } from "node:test";
import { startServer } from "./server";
import { Worker } from "node:worker_threads";
import assert from "node:assert";
import {
    Browser,
    createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { Node } from "../../core/internal/bundle/lib/@types/bundle.ts";

suite("fetch - integration", () => {
    let browser: Browser = null, worker: Worker = null;
    
    before(async () => {
        browser = await createBrowser("test/fetch/sample");
        worker = await startServer();
    });

    test("fetch", async () => {
        const result = await bundle.bundle(Node, "test/fetch/sample/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage();

        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );

            const response = await (globalThis.nodeFetch as typeof fetch)("http://localhost:9090", {
                method: "POST",
                body: new Uint8Array([1, 2, 3])
            })

            const head: typeof response = JSON.parse(await page.getTextContent("#head"));
            assert.deepEqual({
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                url: response.url
            }, {
                status: head.status,
                statusText: head.statusText,
                ok: head.ok,
                url: head.url
            });

            const headers = await page.getTextContent("#headers");
            assert.deepEqual(response.headers.get("x-header-test"), JSON.parse(headers)["x-header-test"]);

            const body = await page.getTextContent("#body");
            assert.deepEqual(await response.bytes(), new Uint8Array(JSON.parse(body)));
        }

        await test();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await test();
    })



    after(() => {
        worker.terminate();
        browser.end()
    });
});