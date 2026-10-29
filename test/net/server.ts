import { startWorkerServer } from "../server.ts";

// an echo server
export function startServer() {
    return startWorkerServer("./test/net/server-net.js");
}
