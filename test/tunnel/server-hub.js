import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { DATA, encodeFrame, serveMux } from "./mux-hub.js";
import { payload } from "./payload.ts";

// stands in for the tunnel hub's edge cases:
// - payloadSize: sends one DATA frame of that many bytes on every stream
//   (the hub sends one frame per target socket read, up to 32 KiB)
// - refuseStatus: refuses the upgrade with that HTTP status
const { payloadSize, refuseStatus } = workerData;

const wss = new WebSocketServer({
    port: 0,
    verifyClient: refuseStatus
        ? (_, callback) => callback(false, refuseStatus)
        : undefined
});

wss.on("connection", (ws) => {
    serveMux(ws, (stream) => {
        stream.opened();
        ws.send(encodeFrame(DATA, stream.id, payload(payloadSize)), {
            binary: true
        });
    });
});

wss.on("listening", () => {
    parentPort.postMessage(wss.address().port);
});
