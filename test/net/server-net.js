import net from "node:net";
import { parentPort } from "node:worker_threads";

const server = net.createServer();
server.on("connection", (socket) => {
    socket.on("data", (data) => socket.write(data));
});
// a port the system picks, posted once bound (test/server.ts)
server.listen(0, () => parentPort.postMessage(server.address().port));
