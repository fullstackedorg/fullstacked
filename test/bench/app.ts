// The net bench as an app run by the CLI (see app-run.ts): bundled, net and
// tunnel are lib/net and lib/tunnel on lib/stream, lib/process..., what an
// app's drivers get.
import net from "net";
import tunnel from "../../core/internal/bundle/lib/tunnel/index.ts";
import { bench, print, type Socket } from "./cases.ts";

// set by app-run.ts
const [echoPort, slowPort, hubPort] =
    process.env.BENCH_PORTS.split(",").map(Number);
const json = process.env.BENCH_JSON === "1";

const tunnelName = "bench-tunnel";
await tunnel.register({
    name: tunnelName,
    host: "127.0.0.1",
    port: hubPort,
    unsecure: true
});
await tunnel.register({
    name: `${tunnelName}-slow`,
    host: "127.0.0.1",
    port: hubPort,
    path: "/slow",
    unsecure: true
});

function connect(host: string, target = "echo"): Promise<Socket> {
    const viaTunnel = host === tunnelName;
    return new Promise((resolve, reject) => {
        const socket = net.connect(
            target === "slow" ? slowPort : echoPort,
            viaTunnel && target === "slow" ? `${tunnelName}-slow` : host
        );
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

print(
    {
        runtime: await bench((target) => connect("127.0.0.1", target)),
        tunnel: await bench((target) => connect(tunnelName, target))
    },
    json
);
