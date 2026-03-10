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
    res.writeHead(200, { "x-header-test": "test" });

    if (req.url === "/wait") {
        await new Promise((resolve) =>
            setTimeout(resolve, parseInt(req.headers["x-wait"] || "0"))
        );
    }

    if (req.url === "/stream") {
        for (let i = 0; i < 10; i++) {
            res.write("chunk");

            await new Promise((resolve) =>
                setTimeout(resolve, parseInt(req.headers["x-wait"] || "0"))
            );
        }
        return res.end();
    }

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
