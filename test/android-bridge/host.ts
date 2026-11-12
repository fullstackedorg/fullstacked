import http from "node:http";
import type { AddressInfo } from "node:net";

// A model of the Android host's bridge (platform/android Bridge.kt) in front
// of the Node webview, which answers the calls: GET /bridge answers
// "message" (the host reads no request body), the page gets a
// `fullstackedCore` and a `fullstackedBridge` (see androidPage), and the
// workers read the response of their sync calls with GET /sync/{key}. Like
// Bridge.kt, coreCall keeps every response for GET /sync/{id}, callSync
// keeps none and relaySync keeps it under its key.
export async function startAndroidHost(webviewPort: number) {
    const syncResponses = new Map<number, string>();
    const syncAwaiters = new Map<number, (response: string) => void>();

    const resolveSync = (key: number, response: string) => {
        const awaiter = syncAwaiters.get(key);
        if (awaiter) {
            syncAwaiters.delete(key);
            awaiter(response);
        } else {
            syncResponses.set(key, response);
        }
    };

    // Core.coreCall: the core answers the call (POST /sync of the Node
    // webview, it reads bodies)
    const call = async (payload: Buffer, path = "/sync") => {
        const response = await fetch(`http://localhost:${webviewPort}${path}`, {
            method: "POST",
            body: payload
        });
        return Buffer.from(await response.arrayBuffer());
    };

    // the async calls of a batch, in order: [length u32 BE][payload]...,
    // replied as [id u8][length u32 BE][response]...
    const callAsync = async (batch: Buffer) => {
        const replies: Buffer[] = [];
        let offset = 0;
        while (offset + 4 <= batch.byteLength) {
            const length = batch.readUInt32BE(offset);
            offset += 4;
            const payload = batch.subarray(offset, offset + length);
            offset += length;
            const response = await call(payload, "/call");
            const header = Buffer.alloc(5);
            header[0] = payload[1];
            header.writeUInt32BE(response.byteLength, 1);
            replies.push(header, response);
        }
        return Buffer.concat(replies);
    };

    const readBody = (req: http.IncomingMessage) =>
        new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => resolve(Buffer.concat(chunks)));
            req.on("error", reject);
        });

    const proxy = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const forwarded = http.request(
            {
                host: "localhost",
                port: webviewPort,
                path: req.url,
                method: req.method,
                headers: req.headers
            },
            (response) => {
                res.writeHead(response.statusCode, response.headers);
                response.pipe(res);
            }
        );
        forwarded.on("error", () => res.destroy());
        res.on("close", () => forwarded.destroy());
        req.pipe(forwarded);
    };

    // calls made by the page's JavascriptInterface (sync XHRs, base64 bodies)
    const coreInterface = async (
        fn: string,
        arg: string | undefined,
        body: Buffer
    ): Promise<string | Buffer> => {
        if (fn === "callAsync") {
            return callAsync(Buffer.from(body.toString(), "base64"));
        }
        const payload = Buffer.from(body.toString(), "base64");
        const response = (await call(payload)).toString("base64");
        switch (fn) {
            case "coreCall":
                resolveSync(payload[1], response);
                return response;
            case "callSync":
                return response;
            case "relaySync":
                resolveSync(Number(arg), response);
                return "";
        }
        throw new Error(`unknown fn ${fn}`);
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean);

        if (url.pathname === "/bridge") {
            return res.end("message");
        }

        if (parts[0] === "sync" && parts.length === 2) {
            const key = Number(parts[1]);
            const send = (response: string) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(response);
            };
            const response = syncResponses.get(key);
            if (response !== undefined) {
                syncResponses.delete(key);
                send(response);
            } else {
                syncAwaiters.set(key, send);
            }
            return;
        }

        if (parts[0] === "android") {
            try {
                const response = await coreInterface(
                    parts[1],
                    parts[2],
                    await readBody(req)
                );
                res.writeHead(200, {
                    "content-type":
                        typeof response === "string"
                            ? "text/plain"
                            : "application/octet-stream"
                });
                res.end(response);
            } catch (e) {
                res.writeHead(500);
                res.end(String(e));
            }
            return;
        }

        proxy(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    return {
        port: (server.address() as AddressInfo).port,
        close() {
            server.closeAllConnections();
            server.close();
        }
    };
}

// The page's side of the model (evaluated before the page's scripts, not in
// its workers): `fullstackedCore` (the JavascriptInterface, its calls are
// sync) and `fullstackedBridge` (the web message listener and its replies).
// A "legacy" host has coreCall only, like Bridge.kt before callSync and
// relaySync.
export function androidPage(mode: "legacy" | "fixed") {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const post = (path: string, body: string) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", path, false);
        xhr.send(body);
        if (xhr.status !== 200) {
            throw new Error(`${path} failed: ${xhr.responseText}`);
        }
        return xhr.responseText;
    };
    const toBase64 = (data: ArrayBuffer) => {
        const bytes = new Uint8Array(data);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };

    let replies = Promise.resolve();
    const bridge = {
        onmessage: null as (event: { data: ArrayBuffer | string }) => void,
        postMessage(message: ArrayBuffer | string) {
            if (message === "init") {
                setTimeout(() => bridge.onmessage({ data: "ready" }));
            } else if (message instanceof ArrayBuffer) {
                callAsync(toBase64(message));
            }
        }
    };
    const callAsync = (batch: string) => {
        replies = replies
            .then(() =>
                nativeFetch("/android/callAsync", {
                    method: "POST",
                    body: batch
                })
            )
            .then((response) => response.arrayBuffer())
            .then((data) => bridge.onmessage({ data }));
    };

    const core: Record<string, Function> = {
        coreCall: (payload: string) => post("/android/coreCall", payload),
        callAsync,
        setOption() {}
    };
    if (mode === "fixed") {
        core.callSync = (payload: string) => post("/android/callSync", payload);
        core.relaySync = (key: number, payload: string) => {
            post(`/android/relaySync/${key}`, payload);
        };
    }

    (globalThis as any).fullstackedCore = core;
    (globalThis as any).fullstackedBridge = bridge;
}
