import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import type { ServerWorker } from "../server.ts";
import { type Browser, createBrowser } from "../browser.ts";
import { startServer } from "../fetch/server.ts";
import {
    resetGitServer,
    startGitServer,
    stopGitServer
} from "../git/server.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import * as ids from "../../core/internal/bundle/lib/bridge/ids.ts";
import { BRIDGE_VERSION } from "../../core/internal/bundle/lib/bridge/shared.ts";

const sample = "test/multi-bundle/sample";
const lib = new URL("../../core/internal/bundle/lib/bridge/", import.meta.url);

// A page that imports a second bundle: each bundle carries its own copy of
// the lib, the page has one bridge (lib/bridge/shared.ts)
suite("multi-bundle - e2e", () => {
    test("a second copy of the lib uses the bridge of the first", async () => {
        const copy = await import(new URL("ids.ts?copy", lib).href);
        assert.strictEqual(copy.acquireId, ids.acquireId);
        assert.strictEqual(copy.releaseId, ids.releaseId);

        const streams = await import(new URL("duplex.ts?copy", lib).href);
        assert.strictEqual(
            streams.default,
            globalThis.fullstacked.onStreamData
        );
    });

    test("a copy of another bridge version throws", async () => {
        const shared = globalThis.fullstacked.__bridge;
        assert.strictEqual(shared.version, BRIDGE_VERSION);
        shared.version = BRIDGE_VERSION + 1;
        try {
            await assert.rejects(
                import(new URL("ids.ts?mismatch", lib).href),
                /bridge version/
            );
        } finally {
            shared.version = BRIDGE_VERSION;
        }
    });

    test("a copy after a lib without a shared bridge throws", async () => {
        // a fresh global scope, where an older lib installed its bridge
        const worker = new Worker(
            `globalThis.fullstacked = { bridge() {} };
            import(${JSON.stringify(new URL("shared.ts", lib).href)}).then(
                () => require("node:worker_threads").parentPort.postMessage("loaded"),
                (e) => require("node:worker_threads").parentPort.postMessage(e.message)
            );`,
            { eval: true }
        );
        const message = await new Promise<string>((resolve) =>
            worker.once("message", resolve)
        );
        await worker.terminate();
        assert.match(message, /without a shared bridge/);
    });
});

suite("multi-bundle - integration", () => {
    let fetchServer: ServerWorker;
    let gitOrigin: string | null = null;
    let browser: Browser;

    const clean = () =>
        fs.rmSync(`${sample}/tmp`, { recursive: true, force: true });

    before(async () => {
        clean();
        fetchServer = await startServer();

        try {
            execSync("docker info", { stdio: "ignore" });
            gitOrigin = (await startGitServer()).origin;
            resetGitServer();
        } catch {
            console.warn(
                "Docker is not running/installed. Skipping git.clone in the multi-bundle test."
            );
        }

        for (const file of ["worker.ts", "second.ts"]) {
            const result = await bundle.bundleFile(`${sample}/${file}`);
            assert.deepEqual(result.Errors, null);
        }
        const result = await bundle.bundle(`${sample}/index.ts`);
        assert.deepEqual(result.Errors, null);

        browser = await createBrowser(sample);
    });

    const params = () => ({
        port: fetchServer.port,
        ...(gitOrigin ? { git: gitOrigin } : {})
    });

    async function results(page: Awaited<ReturnType<Browser["createPage"]>>) {
        await page.page.waitForFunction(
            'document.body.classList.contains("done")',
            { timeout: 120000 }
        );
        return JSON.parse(await page.getTextContent("body"));
    }

    function assertResults(r: any) {
        const ok = {
            fs: "ok",
            fetch: "ok",
            "git.clone": "ok",
            "packages.install": "ok",
            run: "ok"
        };
        assert.deepEqual(r.first.checks, ok);
        assert.deepEqual(r.second.checks, ok);
        assert.notEqual(r.first.ctx, r.second.ctx);
        assert.equal(r.worker, "ok");
        assert.deepEqual(r.flooded, ["ok", "ok"]);
        assert.equal(r.sameBridge, true);
        // the calls of both bundles saturated the ids, none shared one
        assert.equal(r.collisions, 0);
        assert.equal(r.maxInFlight, 255);
        assert.match(r.mismatch, /bridge version/);
        assert.equal(r.after, "first 0");
    }

    test("two bundles use the bridge at the same time", async () => {
        const page = await browser.createPage(browser.url(params()));
        assertResults(await results(page));
        await page.page.close();
    });

    test("a bundle imported while the page's bundle starts", async () => {
        const page = await browser.createPage(null);
        // starts before the page's bundle: the first to load installs the
        // bridge, the other waits for it
        await page.page.evaluateOnNewDocument(() => {
            const second = "/second.ts.js";
            import(second).catch(() => {});
        });
        await page.page.goto(browser.url(params()));
        assertResults(await results(page));
        await page.page.close();
    });

    after(async () => {
        if (browser) await browser.end();
        if (fetchServer) await fetchServer.terminate();
        if (gitOrigin) stopGitServer();
        clean();
        for (const file of ["worker.ts.js", "second.ts.js"]) {
            fs.rmSync(`${sample}/${file}`, { force: true });
        }
    });
});
