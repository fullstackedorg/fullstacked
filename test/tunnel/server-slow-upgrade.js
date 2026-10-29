import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { serveMux } from "./mux-hub.js";

// a tunnel hub stand-in whose upgrades take upgradeDelayMs (DNS, TLS and
// the upgrade through Cloudflare take ~120-250 ms), then echoes every
// stream; on its own thread, it answers whatever the runtime's thread does
const { upgradeDelayMs } = workerData;

const wss = new WebSocketServer({
    port: 0,
    verifyClient: (_, callback) =>
        setTimeout(() => callback(true), upgradeDelayMs)
});

wss.on("connection", (ws) => {
    serveMux(ws, (stream) => {
        stream.opened();
        stream.on("data", (data) => stream.write(data));
        stream.on("end", () => stream.end());
    });
});

wss.on("listening", () => parentPort.postMessage(wss.address().port));
