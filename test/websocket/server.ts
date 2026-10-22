import { startWorkerServer } from "../server.ts";

export function startServer() {
    return startWorkerServer("./test/websocket/server-websocket.js");
}
