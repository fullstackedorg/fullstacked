import { parentPort } from "node:worker_threads";
import dgram from "node:dgram";

const server = dgram.createSocket("udp4");

server.on("message", (msg, rinfo) => {
    // Echo back the message + "ACK"
    server.send(
        Buffer.concat([msg, Buffer.from("ACK")]),
        rinfo.port,
        rinfo.address
    );
});

server.on("listening", () => {
    parentPort.postMessage("ready");
});

// ready once bound: a datagram sent before is dropped, and the test waits
// for its echo forever
server.bind(9091, "127.0.0.1");
