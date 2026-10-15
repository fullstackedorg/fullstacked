import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import nodeFs from "node:fs";
import path from "node:path";
import { type Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { execute } from "../../core/internal/bundle/lib/fullstacked/index.ts";
import { COMMON, PAYLOADS } from "./corpus.ts";

// DOMPurify where the DOM is lib/DOMParser's (a worker of the webview,
// fullstacked --file) against DOMPurify on the browser's DOM (the webview's
// main thread): the same output for the markup of COMMON, nothing the
// browser would run left of PAYLOADS. test/shim/DOMParser compares the
// same corpus in Node against headless Chrome.

type Report = {
    error?: string;
    supported: boolean;
    browser: Record<string, string>;
    worker: Record<string, string>;
    unsafe: Record<string, string[]>;
};

suite("dompurify - integration", () => {
    let browser: Browser;
    let page: Awaited<ReturnType<Browser["createPage"]>>;
    let report: Report;

    before(async () => {
        const worker = await bundle.bundleFile(
            "test/dompurify/sample/worker.ts"
        );
        assert.deepEqual(worker.Errors, null);
        const sample = await bundle.bundle("test/dompurify/sample/index.ts");
        assert.deepEqual(sample.Errors, null);
        browser = await createBrowser("test/dompurify/sample");
        page = await browser.createPage();
        await page.page.waitForFunction(
            'document.body.classList.contains("done")',
            { timeout: 30000 }
        );
        report = JSON.parse(await page.getTextContent("body"));
    });

    test("in a worker", async (t) => {
        assert.equal(report.error, undefined, report.error);
        assert.equal(report.supported, true);
        for (const c of COMMON) {
            await t.test(c.name, () =>
                assert.equal(report.worker[c.name], report.browser[c.name])
            );
        }
        assert.deepEqual(report.unsafe, {});
    });

    test("in fullstacked --file", async (t) => {
        // relative: the runtime's fs is rooted at the project
        const out = "test/dompurify/out/cli.json";
        nodeFs.mkdirSync(path.dirname(out), { recursive: true });
        nodeFs.rmSync(out, { force: true });
        const code = await execute([
            "fullstacked",
            "-f",
            "test/dompurify/sample/cli.ts",
            out
        ]);
        assert.equal(code, 0);
        const cli = JSON.parse(nodeFs.readFileSync(out, "utf8"));
        assert.equal(cli.supported, true);
        for (const c of COMMON) {
            await t.test(c.name, () =>
                assert.equal(cli.results[c.name], report.browser[c.name])
            );
        }
        for (const c of PAYLOADS) {
            const found = await page.page.evaluate(
                (html) => (globalThis as any).unsafeParts(html),
                cli.results[c.name]
            );
            assert.deepEqual(found, [], `${c.name}: ${cli.results[c.name]}`);
        }
    });

    after(() => browser?.end());
});
