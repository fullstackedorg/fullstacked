import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { runContainer, type ServerWorker } from "../server.ts";
import { type Browser, createBrowser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";
import { startServer } from "./server.ts";
import { execSync } from "node:child_process";
import net from "node:net";
import {
    algorithmMatrix,
    prepareKeys,
    prepareServer,
    trySsh
} from "./ssh-algorithms.ts";
import { KNOWN_FAILURES } from "../shim/known-failures.ts";

suite("net - integration", () => {
    let browser: Browser, server: ServerWorker;
    let containerName: string | null = null;

    before(async () => {
        server = await startServer();
        browser = await createBrowser("test/net/sample/basic");
    });

    test("socket", async () => {
        const result = await bundle.bundle("test/net/sample/basic/index.ts");
        assert.deepEqual(result.Errors, null);
        assert.deepEqual(result.Warnings, null);
        const page = await browser.createPage(
            browser.url({ port: server.port })
        );

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

    test("ssh", { timeout: 900000 }, async (t) => {
        containerName = `openssh-server-test-${Date.now()}`;

        // Start openssh-server container with password authentication enabled
        const sshPort = await runContainer(
            containerName,
            "-e PASSWORD_ACCESS=true " +
                "-e USER_NAME=testuser " +
                "-e USER_PASSWORD=testpass " +
                "linuxserver/openssh-server",
            2222
        );

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

            // the core's stream data of a webview goes to one page: the
            // sample page left open would take the next pages' sockets
            await page.page.close();
            prepareServer(containerName);
            const keys = prepareKeys(containerName);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // what packages use ssh2 for in the webview: key formats,
            // exec, shell, SFTP streams, port forwarding
            const featuresPage = await sshBrowser.createPage(
                `http://localhost:${sshBrowser.webview.port}/?port=${sshPort}&features=${encodeURIComponent(btoa(JSON.stringify(keys)))}`
            );
            let features: Record<string, string>;
            try {
                await featuresPage.page.waitForFunction(
                    'document.body.classList.contains("done")',
                    { timeout: 120000, polling: 500 }
                );
                features = JSON.parse(
                    await featuresPage.getTextContent("body")
                );
            } finally {
                await featuresPage.page.close().catch(() => {});
            }
            for (const [name, result] of Object.entries(features)) {
                await t.test(name, () => assert.equal(result, "ok", name));
            }
            assert.ok(Object.keys(features).length >= 10, "feature cases ran");

            // the ssh2 matrix in the webview (crypto shim) against Node's
            // ssh2 on the same server: what Node completes, the webview must.
            // One page per case: a JS key exchange can hold the page longer
            // than a CDP call waits. SSH_MATRIX=<text> keeps the cases whose
            // name contains it.
            for (const c of algorithmMatrix()) {
                const node = await trySsh(sshPort, c);
                let webview: string;
                const matrixPage = await sshBrowser.createPage(
                    `http://localhost:${sshBrowser.webview.port}/?port=${sshPort}&matrix=${encodeURIComponent(btoa(JSON.stringify([c])))}`
                );
                try {
                    await matrixPage.page.waitForFunction(
                        'document.body.classList.contains("done")',
                        { timeout: 40000, polling: 500 }
                    );
                    webview = JSON.parse(
                        await matrixPage.getTextContent("body")
                    )[c.name];
                } catch (e) {
                    webview = `no result: ${(e as Error).message.split("\n")[0]}`;
                } finally {
                    await matrixPage.page.close().catch(() => {});
                }
                const reason = KNOWN_FAILURES.ssh2?.[c.name];
                await t.test(c.name, reason ? { todo: reason } : {}, () => {
                    if (node !== "ok") {
                        t.diagnostic(
                            `${c.name}: refused by the server (${node})`
                        );
                        return;
                    }
                    assert.equal(webview, "ok", `${c.name}: ${webview}`);
                });
            }
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
