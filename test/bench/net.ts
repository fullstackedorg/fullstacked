// Micro-benchmark of a net socket through the runtime, against plain Node:
//
//   npm run build && npm run build -w platform/node
//   node test/bench/net.ts [--modes node,runtime,tunnel] [--json]
//
// modes: node (node:net), runtime (lib/net, a TCP socket of the core),
// tunnel (lib/net through a tunnel, the core's WebSocket to a local hub)
//
// Every case talks to a local echo server (test/bench/servers.js):
// - rtt: sequential 64 B request / response, the added latency per call
// - echo 1 KB / 64 KB / 16 MB: sequential requests of that size, echoed
// - 16 MB in 1 KB writes: written back to back (a driver's pipelined
//   queries), echoed
// - 64 sockets: 64 connections at once, 4 MB each, echoed
// - round trips on one socket while another uploads 32 MB to a peer that
//   reads 50 MB/s
// Throughput counts the bytes of one direction.

import "../../core/internal/bundle/lib/fullstacked/index.ts";
import { stop } from "../../platform/node/src/index.ts";
import netGo from "../../core/internal/bundle/lib/net/index.ts";
import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import net from "node:net";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bench, print, type Socket } from "./cases.ts";

type Mode = "node" | "runtime" | "tunnel";

const args = process.argv.slice(2);
const modesArg = args[args.indexOf("--modes") + 1];
const modes: Mode[] =
    args.includes("--modes") && modesArg
        ? (modesArg.split(",") as Mode[])
        : ["node", "runtime", "tunnel"];
const json = args.includes("--json");

const servers = fork(fileURLToPath(new URL("./servers.js", import.meta.url)));
const { echoPort, slowPort, hubPort } = await new Promise<{
    echoPort: number;
    slowPort: number;
    hubPort: number;
}>((resolve) => servers.once("message", resolve as any));

const tunnelName = "bench-tunnel";
await tunnelGo.register({
    name: tunnelName,
    host: "127.0.0.1",
    port: hubPort,
    unsecure: true
});
await tunnelGo.register({
    name: `${tunnelName}-slow`,
    host: "127.0.0.1",
    port: hubPort,
    path: "/slow",
    unsecure: true
});

function connect(mode: Mode, target = "echo"): Promise<Socket> {
    const port = target === "slow" ? slowPort : echoPort;
    return new Promise((resolve, reject) => {
        let socket: Socket;
        switch (mode) {
            case "node":
                socket = net.connect({
                    port,
                    host: "127.0.0.1",
                    noDelay: true
                });
                break;
            case "runtime":
                socket = netGo.connect(port, "127.0.0.1");
                break;
            case "tunnel":
                socket = netGo.connect(
                    port,
                    target === "slow" ? `${tunnelName}-slow` : tunnelName
                );
                break;
        }
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

const results: Record<string, Awaited<ReturnType<typeof bench>>> = {};
for (const mode of modes) {
    results[mode] = await bench((target) => connect(mode, target));
}
print(results, json);

servers.kill();
stop();
process.exit(0);
