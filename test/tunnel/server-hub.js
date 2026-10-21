import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { payload } from "./payload.ts";

// stands in for the tunnel hub's edge cases:
// - payloadSize: sends one binary message of that many bytes on connection
//   (the hub sends one message per target socket read, up to ~64 KiB)
// - refuseStatus: refuses the upgrade with that HTTP status
const { wsPort, payloadSize, refuseStatus } = workerData;

const wss = new WebSocketServer({
    port: wsPort,
    verifyClient: refuseStatus
        ? (_, callback) => callback(false, refuseStatus)
        : undefined
});

wss.on("connection", (ws) => {
    ws.send(payload(payloadSize), { binary: true });
});

wss.on("listening", () => {
    parentPort.postMessage("ready");
});
