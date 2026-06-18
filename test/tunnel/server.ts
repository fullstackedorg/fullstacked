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
