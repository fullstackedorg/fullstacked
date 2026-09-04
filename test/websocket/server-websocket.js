import { WebSocketServer } from "ws";
import { parentPort } from "node:worker_threads";

const wss = new WebSocketServer({ port: 9092 });

wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
        const str = data.toString();
        if (str === "close-me") {
            ws.close(1000, "normal-close");
            return;
        }
        if (str === "close-4001") {
            ws.close(4001, "custom-close");
            return;
        }
        // Echo back
        ws.send(data, { binary: isBinary });
    });
});

wss.on("listening", () => {
    parentPort.postMessage("ready");
});
