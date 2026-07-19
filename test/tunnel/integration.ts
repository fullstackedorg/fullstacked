import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import http from "node:http";

import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import { startServer } from "../net/server.ts";
import { startTunnelServer } from "./server.ts";
import { createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";

suite("tunnel - integration", () => {
    let tcpServer: Worker;
    let wsTunnelServer: Worker;
    let fetchHttpServer: any;
    let fetchTunnelServer: Worker;

    before(async () => {
        tcpServer = await startServer();
        wsTunnelServer = await startTunnelServer(9091, 9090);

        // Start HTTP server for fetch integration test
        fetchHttpServer = http.createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("fetch integration success");
        });
        await new Promise<void>((resolve) => fetchHttpServer.listen(0, resolve));
        const httpPort = fetchHttpServer.address().port;

        // Start tunnel server for fetch on port 9093
        fetchTunnelServer = await startTunnelServer(9093, httpPort);

        // Register fetch tunnel
        await tunnelGo.register({
            name: "my-fetch-tunnel",
            host: "localhost",
            port: 9093,
            unsecure: true
        });
    });

    test("socket connection through registered tunnel in browser", async () => {
        const result = await bundle.bundle("test/tunnel/sample/socket/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);

        const browser = await createBrowser("test/tunnel/sample/socket");
        try {
            const page = await browser.createPage();
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const bodyContent = await page.getTextContent("body");
            assert.ok(bodyContent.includes("789"));
        } finally {
            await browser.end();
        }
    });

    test("fetch connection through registered tunnel in browser", async () => {
        const result = await bundle.bundle("test/tunnel/sample/fetch/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);

        const browser = await createBrowser("test/tunnel/sample/fetch");
        try {
            const page = await browser.createPage();
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const bodyContent = await page.getTextContent("body");
            assert.deepEqual(bodyContent, "fetch integration success");
        } finally {
            await browser.end();
        }
    });

    after(async () => {
        await tcpServer.terminate();
        await wsTunnelServer.terminate();
        await fetchTunnelServer.terminate();
        await new Promise<void>((resolve) => fetchHttpServer.close(() => resolve()));
    });
});
