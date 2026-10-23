import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { serveMux, spliceToTcp } from "./mux-hub.js";

// forwards every stream to tcpPort, on a port the system picks; the target
// dial takes 500 ms, so the runtime's first bytes wait for it
const { tcpPort } = workerData;

const wss = new WebSocketServer({ port: 0 });

wss.on("connection", (ws) => {
    serveMux(ws, (stream) => spliceToTcp(stream, tcpPort, 500));
});

wss.on("listening", () => {
    parentPort.postMessage(wss.address().port);
});
