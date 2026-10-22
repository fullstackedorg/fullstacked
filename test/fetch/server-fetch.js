import http from "node:http";
import { parentPort } from "node:worker_threads";

function readBody(req) {
    return new Promise((resolve) => {
        let data = new Uint8Array();
        req.on("data", (chunk) => {
            const buffer = new Uint8Array(data.byteLength + chunk.byteLength);
            buffer.set(data);
            buffer.set(chunk, data.length);
            data = buffer;
        });
        req.on("end", () => resolve(data));
    });
}

http.createServer(async (req, res) => {
    if (req.url === "/redirect") {
        res.writeHead(302, {
            Location: "/redirect-target",
            "x-header-test": "test"
        });
        return res.end();
    }

    if (req.url === "/redirect-target") {
        res.writeHead(200, { "x-header-test": "test" });
        return res.end("redirect target reached");
    }

    // the connection drops before any response
    if (req.url === "/drop") {
        return req.socket.destroy();
    }

    // the connection drops partway through the body
    if (req.url === "/cut") {
        res.writeHead(200, { "content-length": 1024 * 1024 });
        res.write(Buffer.alloc(64 * 1024));
        await new Promise((resolve) => setTimeout(resolve, 50));
        return req.socket.destroy();
    }

    // a body of that many deterministic bytes (i % 251), in 64 KiB writes
    if (req.url.startsWith("/bytes/")) {
        const size = parseInt(req.url.slice("/bytes/".length));
        const data = Buffer.alloc(size);
        for (let i = 0; i < size; i++) data[i] = i % 251;
        res.writeHead(200, { "content-length": size });
        for (let i = 0; i < size; i += 64 * 1024) {
            if (!res.write(data.subarray(i, i + 64 * 1024))) {
                await new Promise((resolve) => res.once("drain", resolve));
            }
        }
        return res.end();
    }

    if (req.url === "/wait") {
        await new Promise((resolve) =>
            setTimeout(resolve, parseInt(req.headers["x-wait"] || "0"))
        );
    }

    if (req.url === "/stream") {
        res.writeHead(200, { "x-header-test": "test" });
        for (let i = 0; i < 10; i++) {
            res.write("chunk");

            await new Promise((resolve) =>
                setTimeout(resolve, parseInt(req.headers["x-wait"] || "0"))
            );
        }
        return res.end();
    }

    res.writeHead(200, { "x-header-test": "test" });

    const responseBody =
        req.method === "POST"
            ? await readBody(req)
            : req.url === "/json"
              ? '{ "test" : 123 }'
              : "test";

    res.end(responseBody);
}).listen(9090, () => {
    parentPort.postMessage("ready");
});
