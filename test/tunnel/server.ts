import { startWorkerServer } from "../server.ts";

// a tunnel hub stand-in that forwards each connection to tcpPort
export function startTunnelServer(tcpPort: number) {
    return startWorkerServer("./test/tunnel/server-tunnel.js", { tcpPort });
}

export function startHubServer(opts: {
    payloadSize?: number;
    refuseStatus?: number;
}) {
    return startWorkerServer("./test/tunnel/server-hub.js", opts);
}

export function startSlowUpgradeServer(upgradeDelayMs: number) {
    return startWorkerServer("./test/tunnel/server-slow-upgrade.js", {
        upgradeDelayMs
    });
}
