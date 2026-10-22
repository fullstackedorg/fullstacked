import { parentPort } from "node:worker_threads";
import { WebSocketServer } from "ws";
import http from "node:http";
import net from "node:net";
import { payload } from "./payload.ts";

// stands in for the tunnel hub and its targets under load, on its own thread
// so it keeps up whatever the runtime's thread does:
// - path /echo: echoes every message (a database socket)
// - any other path: forwards to an HTTP server (an S3 bucket):
//   - GET /<size>: <size> deterministic bytes
//   - GET /drop/<size>: the connection drops before the response
//   - GET /cut/<size>: the connection drops partway through the body
const httpServer = http.createServer((req, res) => {
    const [, mode, sizeParam] = req.url.match(/^\/(?:(drop|cut)\/)?(\d+)$/);
    const body = payload(parseInt(sizeParam, 10));

    if (mode === "drop") {
        return req.socket.destroy();
    }

    res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": body.byteLength
    });

    if (mode === "cut") {
        res.write(body.subarray(0, body.byteLength / 4), () =>
            req.socket.destroy()
        );
        return;
    }

    res.end(body);
});

httpServer.listen(0, "127.0.0.1", () => {
    const httpPort = httpServer.address().port;

    const wss = new WebSocketServer({ port: 0 });

    wss.on("connection", (ws, req) => {
        if (req.url === "/echo") {
            ws.on("message", (data) => ws.send(data, { binary: true }));
            return;
        }

        const tcpSocket = net.connect(httpPort, "127.0.0.1");
        const pending = [];
        tcpSocket.on("connect", () => {
            pending.forEach((data) => tcpSocket.write(data));
            pending.length = 0;
        });
        ws.on("message", (data) => {
            if (tcpSocket.connecting) {
                pending.push(data);
            } else {
                tcpSocket.write(data);
            }
        });
        tcpSocket.on("data", (data) => ws.send(data, { binary: true }));
        ws.on("close", () => tcpSocket.destroy());
        ws.on("error", () => tcpSocket.destroy());
        tcpSocket.on("close", () => ws.close());
        tcpSocket.on("error", () => ws.close());
    });

    wss.on("listening", () => parentPort.postMessage(wss.address().port));
});
