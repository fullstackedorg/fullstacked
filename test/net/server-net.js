import net from "node:net";
import { parentPort } from "node:worker_threads";

const server = net.createServer()
server.on("connection", (socket) => {

    socket.on("data", data => socket.write(data));
})
server.listen(9090)

parentPort.postMessage("ready")
