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
    const responseBody = req.method === "POST" ? await readBody(req) : "test";
    res.end(responseBody);
}).listen(9090, () => {
    parentPort.postMessage("ready");
});
