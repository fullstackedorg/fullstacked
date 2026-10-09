import http from "node:http";
import net from "node:net";
import open from "open";
import type { Core } from "./core.ts";
import { createBridge } from "./bridge.ts";

const args = process.argv;
const portIndex = args.findIndex((arg) => arg === "-p" || arg === "--port");
let mainPort = 9000;
if (portIndex !== -1 && args[portIndex + 1]) {
    mainPort = parseInt(args[portIndex + 1]);
    if (isNaN(mainPort)) {
        mainPort = 9000;
    }
}

export type CreateWebViewOpts = {
    quiet?: boolean;
    didClose?: () => void;
};

const activeServers = new Set<http.Server>();

export async function createWebViewWithCore(
    core: Core,
    ctx: number,
    opts?: CreateWebViewOpts
) {
    const port = await getNextAvailablePort(mainPort);
    const server = http.createServer();
    activeServers.add(server);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        core.stop(ctx);
        bridge.close();
        server?.closeAllConnections?.();
        server.close();
        activeServers.delete(server);
        opts?.didClose?.();
    };
    const bridge = createBridge(core, ctx, close);
    server.on("request", createHandler(bridge, close));

    server.listen(port);

    if (!opts?.quiet) {
        console.log(`Listening at http://localhost:${port}`);
    }

    if (!process.env.TEST) {
        open(`http://localhost:${port}`);
    }

    return {
        close,
        port
    };
}

// the UI endpoints of the page, the rest goes to the bridge
function createHandler(
    bridge: ReturnType<typeof createBridge>,
    close: () => void
) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/open") {
            const ctx = Number(url.searchParams.get("ctx"));
            if (ctx) globalThis.fullstacked.open(ctx);
            return res.end();
        }
        if (url.pathname === "/exit") {
            res.end();
            return close();
        }
        return bridge.request(req, res, url.pathname);
    };
}

export function staticFileWithCore(core: Core, ctx: number, pathname: string) {
    const [status, mimeType, data] = core.request(ctx, pathname);
    return status === 200
        ? { found: true, mimeType, data }
        : {
              found: false,
              mimeType: "text/plain",
              data: new TextEncoder().encode("not found")
          };
}

function getNextAvailablePort(
    port: number = 9000,
    host = "0.0.0.0"
): Promise<number> {
    for (const s of activeServers) {
        if ((s.address() as net.AddressInfo).port === port) {
            return getNextAvailablePort(++port);
        }
    }
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();

        const timeout = () => {
            resolve(port);
            socket.destroy();
        };

        const next = () => {
            socket.destroy();
            resolve(getNextAvailablePort(++port));
        };

        setTimeout(timeout, 200);
        socket.on("timeout", timeout);

        socket.on("connect", function () {
            next();
        });

        socket.on("error", function (exception) {
            if ((exception as any).code !== "ECONNREFUSED") {
                reject(exception);
            } else {
                timeout();
            }
        });

        socket.connect(port, host);
    });
}
