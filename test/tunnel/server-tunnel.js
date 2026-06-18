import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";
import net from "node:net";

const { wsPort, tcpPort } = workerData;

const wss = new WebSocketServer({ port: wsPort });

wss.on("connection", (ws) => {
    const tcpSocket = net.connect(tcpPort, "127.0.0.1");

    ws.on("message", (data) => {
        let buffer;
        if (Buffer.isBuffer(data)) {
            buffer = data;
        } else if (data instanceof ArrayBuffer) {
            buffer = Buffer.from(data);
        } else if (Array.isArray(data)) {
            buffer = Buffer.concat(data);
        } else {
            buffer = Buffer.from(data);
        }
        tcpSocket.write(buffer);
    });

    tcpSocket.on("data", (data) => {
        ws.send(data, { binary: true });
    });

    ws.on("close", () => {
        tcpSocket.destroy();
    });

    tcpSocket.on("close", () => {
        ws.close();
    });

    ws.on("error", (err) => {
        console.error("WS Tunnel Error:", err);
        tcpSocket.destroy();
    });

    tcpSocket.on("error", (err) => {
        console.error("TCP Tunnel Error:", err);
        ws.close();
    });
});

wss.on("listening", () => {
    parentPort.postMessage("ready");
});
