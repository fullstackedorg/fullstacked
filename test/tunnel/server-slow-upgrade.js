import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";

// a tunnel hub stand-in whose upgrades take upgradeDelayMs (DNS, TLS and
// the upgrade through Cloudflare take ~120-250 ms), then echoes every
// message; on its own thread, it answers whatever the runtime's thread does
const { wsPort, upgradeDelayMs } = workerData;

const wss = new WebSocketServer({
    port: wsPort,
    verifyClient: (_, callback) =>
        setTimeout(() => callback(true), upgradeDelayMs)
});

wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data, { binary: true }));
});

wss.on("listening", () => parentPort.postMessage("ready"));
