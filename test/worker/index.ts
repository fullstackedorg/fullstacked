import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import type { ServerWorker } from "../server.ts";
import { type Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import { startServer } from "../net/server.ts";
import { startTunnelServer } from "../tunnel/server.ts";

suite("worker - integration", () => {
    let tcpServer: ServerWorker;
    let wsTunnelServer: ServerWorker;
    let browser: Browser;

    before(async () => {
        // Start TCP echo server
        tcpServer = await startServer();

        // Start WS tunnel server pointing to the TCP server
        wsTunnelServer = await startTunnelServer(tcpServer.port);

        // Register the tunnel
        await tunnelGo.register({
            name: "test-tunnel-worker",
            host: "localhost",
            port: wsTunnelServer.port,
            unsecure: true
        });

        // Bundle the worker script into test/worker/sample/worker.ts.js
        const workerBundleResult = await bundle.bundleFile(
            "test/worker/sample/worker.ts"
        );
        assert.deepEqual(workerBundleResult.Errors, null);

        // Bundle the web entry point
        const sampleBundleResult = await bundle.bundle(
            "test/worker/sample/index.ts"
        );
        assert.deepEqual(sampleBundleResult.Errors, null);

        // Create browser webview for test/worker/sample
        browser = await createBrowser("test/worker/sample");
    });

    test("worker bridge functionality (path, fs, socket, tunnel)", async () => {
        const page = await browser.createPage(
            browser.url({ port: tcpServer.port })
        );

        // Wait for worker tests to finish and write to body
        await page.page.waitForFunction(
            'document.body.classList.contains("done")'
        );

        const result = await page.getTextContent("body");
        assert.deepEqual(result, "SUCCESS");
    });

    after(async () => {
        if (tcpServer) tcpServer.terminate();
        if (wsTunnelServer) wsTunnelServer.terminate();
        if (browser) await browser.end();
    });
});
