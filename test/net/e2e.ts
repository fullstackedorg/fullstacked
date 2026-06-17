import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import netGo from "../../core/internal/bundle/lib/net/index.ts";
import { mergeUint8Arrays } from "../../core/internal/bundle/lib/bridge/serialization.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";
import { NodeSSH } from "node-ssh";
import { execSync } from "node:child_process";
import net from "node:net";

suite("net - e2e", () => {
    let server: Worker;
    let containerName: string | null = null;

    before(async () => {
        server = await startServer();
    });

    test("connect - single write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise((resolve) => {
            socket.on("connect", () => {
                socket.write(data);
                setTimeout(socket.destroy.bind(socket), 100);
            });
            socket.on(
                "data",
                (chunk) => (received = mergeUint8Arrays(received, chunk))
            );
            socket.on("close", resolve);
            socket.connect(9090);
        });
        assert.deepEqual(received, data);
    });

    test("connect - multiple write", async () => {
        const data = new Uint8Array([1, 2, 3]);
        let received = new Uint8Array();
        const socket = new netGo.Socket();
        await new Promise((resolve) => {
            socket.on("connect", async () => {
                for (let i = 0; i < data.byteLength; i++) {
                    socket.write(new Uint8Array([data[i]]));
                    await new Promise((res) => setTimeout(res, 100));
                }
                socket.destroy();
            });
            socket.on(
                "data",
                (chunk) => (received = mergeUint8Arrays(received, chunk))
            );
            socket.on("close", resolve);
            socket.connect(9090);
        });
        assert.deepEqual(received, data);
    });

    test("ssh", async () => {
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

        try {
            // Get mapped port
            const portOutput = execSync(`docker port ${containerName} 2222`, { encoding: "utf8" }).trim();
            const match = portOutput.match(/:(\d+)$/);
            if (!match) {
                throw new Error(`Failed to parse port: ${portOutput}`);
            }
            const port = parseInt(match[1], 10);

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
                    socket.once("error", () => done(false));
                    socket.once("close", () => done(false));
                    socket.once("timeout", () => done(false));
                    socket.connect(port, "127.0.0.1");
                });
                if (success) {
                    connected = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            assert.ok(connected, "SSH server did not become ready in time");

            // Wait an additional 2 seconds to ensure openssh has started accepting auth requests
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Create netGo.Socket
            const socket = new netGo.Socket();
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
                socket.connect(port, "127.0.0.1");
            });

            // Connect using node-ssh passing the custom socket
            const ssh = new NodeSSH();
            await ssh.connect({
                sock: socket,
                host: "127.0.0.1",
                port: port,
                username: "testuser",
                password: "testpass",
                readyTimeout: 30000
            });

            const result = await ssh.execCommand("echo 'SSH E2E WORKING'");
            assert.deepEqual(result.stdout.trim(), "SSH E2E WORKING");

            ssh.dispose();
        } finally {
            if (containerName) {
                try {
                    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
                } catch {
                    // ignore
                }
                containerName = null;
            }
        }
    });

    after(() => {
        server.terminate();
        if (containerName) {
            try {
                execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
            } catch {
                // ignore
            }
        }
    });
});
