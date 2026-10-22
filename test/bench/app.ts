// The net bench as an app run by the CLI (see app-run.ts): bundled, net and
// tunnel are lib/net and lib/tunnel on lib/stream, lib/process..., what an
// app's drivers get.
import net from "net";
import tunnel from "tunnel";
import { bench, print, type Socket } from "./cases.ts";

// set by app-run.ts
const [echoPort, hubPort] = process.env.BENCH_PORTS.split(",").map(Number);
const json = process.env.BENCH_JSON === "1";

const tunnelName = "bench-tunnel";
await tunnel.register({
    name: tunnelName,
    host: "127.0.0.1",
    port: hubPort,
    unsecure: true
});

function connect(host: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(echoPort, host);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

print(
    {
        runtime: await bench(() => connect("127.0.0.1")),
        tunnel: await bench(() => connect(tunnelName))
    },
    json
);
