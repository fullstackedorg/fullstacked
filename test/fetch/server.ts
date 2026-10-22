import { startWorkerServer } from "../server.ts";

export function startServer() {
    return startWorkerServer("./test/fetch/server-fetch.js");
}
