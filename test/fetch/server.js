import http from "node:http";
import { parentPort } from "node:worker_threads";

http.createServer((_, res) => {
    res.writeHead(200, {"x-header-test": "test"});
    res.end("test");
}).listen(9000);

parentPort.postMessage("ready");
