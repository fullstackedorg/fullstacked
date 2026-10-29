import net from "node:net";
import { parentPort, workerData } from "node:worker_threads";

// an echo server that reads nothing for pauseMs after a connection, like a
// peer slow to take the data
const { pauseMs } = workerData;

const server = net.createServer((socket) => {
    socket.pause();
    setTimeout(() => {
        socket.on("data", (data) => socket.write(data));
        socket.resume();
    }, pauseMs);
});
server.listen(0, "127.0.0.1", () => {
    parentPort.postMessage(server.address().port);
});
