import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { type Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";

const sample = "test/plugin-worker/sample";

// plugin.load: a build plugin runs in a worker, the page keeps running and
// keeps its own plugins (the core gives each runtime its plugin stream)
suite("plugin worker - integration", () => {
    let browser: Browser;

    const clean = () => {
        for (const dir of ["app/out", "out"]) {
            fs.rmSync(`${sample}/${dir}`, { recursive: true, force: true });
        }
    };

    before(async () => {
        clean();
        const result = await bundle.bundle(`${sample}/index.ts`);
        assert.deepEqual(result.Errors, null);
        browser = await createBrowser(sample);
    });

    test("build plugins run in a worker unless they ask for the page", async () => {
        const page = await browser.createPage();
        await page.page.waitForFunction(
            'document.body.classList.contains("done")',
            { timeout: 120000 }
        );
        const r = JSON.parse(await page.getTextContent("body"));
        assert.equal(r.error, undefined);

        // in a worker: the page's timers kept running through 400 ms of work
        assert.equal(r.busy.worker, true);
        assert.deepEqual(r.busy.errors, []);
        assert.equal(r.busy.output, "worker");
        assert.ok(r.busy.longest < 200, `page stalled ${r.busy.longest} ms`);

        // the page's deeplink plugin, with the worker's and after it
        assert.equal(r.deeplinkWithWorker, true);
        assert.equal(r.deeplinkAfterWorker, true);

        // data.worker: false, on the page: the page stalls
        assert.equal(r.page.worker, false);
        assert.equal(r.page.output, "page");
        assert.ok(r.page.longest >= 350, `page stalled ${r.page.longest} ms`);

        // a worker that dies fails the build instead of hanging it
        assert.equal(r.crash.worker, true);
        assert.match(r.crash.errors.join("\n"), /plugin stream closed/);
        assert.equal(r.deeplinkAfterCrash, true);

        assert.deepEqual(r.leftovers, []);
        await page.page.close();
    });

    after(async () => {
        if (browser) await browser.end();
        clean();
    });
});
