import { Worker } from "node:worker_threads";

export function startTunnelServer(wsPort: number, tcpPort: number) {
    return new Promise<Worker>((res) => {
        const worker = new Worker("./test/tunnel/server-tunnel.js", {
            workerData: { wsPort, tcpPort }
        });
        worker.on("message", () => res(worker));
        worker.on("error", console.log);
    });
}

export function startHubServer(
    wsPort: number,
    opts: { payloadSize?: number; refuseStatus?: number }
) {
    return new Promise<Worker>((res) => {
        const worker = new Worker("./test/tunnel/server-hub.js", {
            workerData: { wsPort, ...opts }
        });
        worker.on("message", () => res(worker));
        worker.on("error", console.log);
    });
}
