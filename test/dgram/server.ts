import { startWorkerServer } from "../server.ts";

// an echo server that appends "ACK"
export function startServer() {
    return startWorkerServer("./test/dgram/server-dgram.js");
}
