import { parentPort } from "worker_threads";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import crypto, { randomUUID } from "crypto";

async function runTests() {
    try {
        // 0. Test crypto.randomUUID
        const uuid1 = crypto.randomUUID();
        const uuid2 = randomUUID();
        if (
            typeof uuid1 !== "string" ||
            uuid1.length !== 36 ||
            uuid1.split("-").length !== 5
        ) {
            throw new Error(`Invalid UUID: ${uuid1}`);
        }
        if (
            typeof uuid2 !== "string" ||
            uuid2.length !== 36 ||
            uuid2.split("-").length !== 5
        ) {
            throw new Error(`Invalid UUID: ${uuid2}`);
        }

        // 1. Test path module
        const joined = path.join("test", "dir", "file.txt");
        if (!joined.includes("test") || !joined.includes("file.txt")) {
            throw new Error(`Path join failed: ${joined}`);
        }

        // 2. Test fs module
        const testFile = path.resolve("test_worker_fs.txt");
        const content = "Hello from Web Worker!";
        await fs.promises.writeFile(testFile, content);

        const readBack = await fs.promises.readFile(testFile, "utf-8");
        if (readBack !== content) {
            throw new Error(
                `FS read/write failed: expected "${content}", got "${readBack}"`
            );
        }

        await fs.promises.rm(testFile);

        // 3. Test direct socket (TCP loopback on port 9090)
        let receivedDirect = "";
        const socketDirect = new net.Socket();
        await new Promise<void>((resolve, reject) => {
            socketDirect.on("connect", () => {
                socketDirect.write("direct-echo");
            });
            socketDirect.on("data", (chunk) => {
                receivedDirect += chunk.toString();
                socketDirect.destroy();
            });
            socketDirect.on("close", () => {
                if (receivedDirect === "direct-echo") {
                    resolve();
                } else {
                    reject(
                        new Error(
                            `Direct TCP socket echo failed: got "${receivedDirect}"`
                        )
                    );
                }
            });
            socketDirect.on("error", reject);
            socketDirect.connect(9090, "127.0.0.1");
        });

        // 4. Test tunnel socket (proxied TCP loopback on port 9090 via tunnel "test-tunnel-worker")
        let receivedTunnel = "";
        const socketTunnel = new net.Socket();
        await new Promise<void>((resolve, reject) => {
            socketTunnel.on("connect", () => {
                socketTunnel.write("tunnel-echo");
            });
            socketTunnel.on("data", (chunk) => {
                receivedTunnel += chunk.toString();
                socketTunnel.destroy();
            });
            socketTunnel.on("close", () => {
                if (receivedTunnel === "tunnel-echo") {
                    resolve();
                } else {
                    reject(
                        new Error(
                            `Tunnel socket echo failed: got "${receivedTunnel}"`
                        )
                    );
                }
            });
            socketTunnel.on("error", reject);
            socketTunnel.connect(9090, "test-tunnel-worker");
        });

        parentPort.postMessage({ success: true });
    } catch (err: any) {
        parentPort.postMessage({
            success: false,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

runTests();
