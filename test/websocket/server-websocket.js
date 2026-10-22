import { WebSocketServer } from "ws";
import { parentPort } from "node:worker_threads";

// a port the system picks, posted once bound (test/server.ts)
const wss = new WebSocketServer({ port: 0 });

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
    parentPort.postMessage(wss.address().port);
});
