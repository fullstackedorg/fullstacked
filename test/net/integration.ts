import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { Browser, createBrowser } from "../browser.ts";
import * as bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { startServer } from "./server.ts";
import { execSync } from "node:child_process";
import net from "node:net";

suite("net - integration", () => {
    let browser: Browser, server: Worker;
    let containerName: string | null = null;

    before(async () => {
        server = await startServer();
        browser = await createBrowser("test/net/sample/basic");
    });

    test("socket", async () => {
        const result = await bundle.bundle("test/net/sample/basic/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage();

        const test = async () => {
            await page.page.waitForFunction(
                'document.body.classList.contains("done")'
            );
            const streamed = await page.getTextContent("body");
            assert.deepEqual(streamed, "123");
        };

        await test();

        await page.page.emulateCPUThrottling(4);
        await page.page.reload();
        await test();
    });

    test("ssh", async () => {
        containerName = `openssh-server-test-${Date.now()}`;
        console.log(`[TEST LOG] Starting Docker container: ${containerName}`);

        // Start openssh-server container with password authentication enabled
        execSync(
            `docker run -d --name ${containerName} ` +
            `-e PASSWORD_ACCESS=true ` +
            `-e USER_NAME=testuser ` +
            `-e USER_PASSWORD=testpass ` +
            `-p 127.0.0.1::2222 ` +
            `linuxserver/openssh-server`,
            { stdio: "pipe" }
        );

        // Get the dynamic host port mapped to container port 2222
        const portOutput = execSync(`docker port ${containerName} 2222`, { encoding: "utf8" }).trim();
        const match = portOutput.match(/:(\d+)$/);
        if (!match) {
            throw new Error(`Failed to parse docker port output: ${portOutput}`);
        }
        const sshPort = parseInt(match[1], 10);
        console.log(`[TEST LOG] SSH Docker port mapped to: ${sshPort}`);

        // Wait for SSH to be ready by reading the greeting
        console.log(`[TEST LOG] Waiting for SSH daemon greeting...`);
        let connected = false;
        for (let i = 0; i < 40; i++) {
            const socket = new net.Socket();
            const success = await new Promise<boolean>((resolve) => {
                let resolved = false;
                const done = (val: boolean) => {
                    if (resolved) return;
                    resolved = true;
                    socket.destroy();
                    resolve(val);
                };

                socket.setTimeout(1500);
                socket.once("data", (data) => {
                    const str = data.toString();
                    console.log(`[TEST LOG] Socket received: ${str.trim()}`);
                    done(str.startsWith("SSH-"));
                });
                socket.once("error", (err) => {
                    console.log(`[TEST LOG] Socket error (refused/reset is normal during startup): ${err.message}`);
                    done(false);
                });
                socket.once("close", () => {
                    done(false);
                });
                socket.once("timeout", () => {
                    console.log(`[TEST LOG] Socket connection timed out`);
                    done(false);
                });
                socket.connect(sshPort, "127.0.0.1");
            });
            if (success) {
                connected = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (!connected) {
            throw new Error("SSH server failed to become ready in time");
        }
        console.log(`[TEST LOG] SSH Daemon greeting received! Stabilizing 2s...`);

        // Wait an additional 2 seconds to ensure openssh has started accepting auth requests
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Create browser for ssh sample
        console.log(`[TEST LOG] Creating browser for ssh sample...`);
        const sshBrowser = await createBrowser("test/net/sample/ssh");
        try {
            console.log(`[TEST LOG] Bundling ssh sample...`);
            const result = await bundle.bundle("test/net/sample/ssh/index.ts");
            assert.deepEqual(result.Errors, null);
            assert.deepEqual(result.Warnings, null);

            // Navigate passing the dynamic ssh port in query parameters
            console.log(`[TEST LOG] Navigating browser page...`);
            const page = await sshBrowser.createPage(
                `http://localhost:${sshBrowser.webview.port}/?port=${sshPort}`
            );

            // Listen to browser console messages to print them for debugging
            page.page.on("console", (msg) => {
                console.log(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`);
            });
            page.page.on("pageerror", (err: any) => {
                console.error(`[BROWSER PAGEERROR] ${err.message}`);
            });

            console.log(`[TEST LOG] Waiting for body class "done"...`);
            await page.page.waitForFunction(
                'document.body.classList.contains("done")',
                { timeout: 35000 }
            );

            const content = await page.getTextContent("body");
            console.log(`[TEST LOG] Text content of body: ${content}`);
            assert.deepEqual(content, "SUCCESS");
        } finally {
            console.log(`[TEST LOG] Cleaning up sshBrowser and container...`);
            sshBrowser.end();
            if (containerName) {
                try {
                    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
                    console.log(`[TEST LOG] Container ${containerName} removed.`);
                } catch {
                    // ignore
                }
                containerName = null;
            }
        }
    });

    after(() => {
        server.terminate();
        browser.end();
        if (containerName) {
            try {
                execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
            } catch {
                // ignore
            }
        }
    });
});
