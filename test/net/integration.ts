import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { type Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
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

    test("ssh", { timeout: 15000 }, async () => {
        containerName = `openssh-server-test-${Date.now()}`;

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
        const portOutput = execSync(`docker port ${containerName} 2222`, {
            encoding: "utf8"
        }).trim();
        const match = portOutput.match(/:(\d+)$/);
        if (!match) {
            throw new Error(
                `Failed to parse docker port output: ${portOutput}`
            );
        }
        const sshPort = parseInt(match[1], 10);

        // Wait for SSH to be ready by reading the greeting
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
                    done(str.startsWith("SSH-"));
                });
                socket.once("error", (err) => {
                    done(false);
                });
                socket.once("close", () => {
                    done(false);
                });
                socket.once("timeout", () => {
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

        // Wait an additional 2 seconds to ensure openssh has started accepting auth requests
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Create browser for ssh sample
        const sshBrowser = await createBrowser("test/net/sample/ssh");
        try {
            const result = await bundle.bundle("test/net/sample/ssh/index.ts");
            assert.deepEqual(result.Errors, null);
            assert.deepEqual(result.Warnings, null);

            // Navigate passing the dynamic ssh port in query parameters
            const page = await sshBrowser.createPage(
                `http://localhost:${sshBrowser.webview.port}/?port=${sshPort}`
            );

            await page.page.waitForFunction(
                'document.body.classList.contains("done")',
                { timeout: 35000 }
            );

            const content = await page.getTextContent("body");
            assert.deepEqual(content, "SUCCESS");
        } finally {
            sshBrowser.end();
            if (containerName) {
                try {
                    execSync(`docker rm -f ${containerName}`, {
                        stdio: "ignore"
                    });
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
