// fullstacked -f test/node/sample/keep-alive.ts [seconds] [--no-interval]
//
// A socket through the core (net of FullStacked) to an echo server of Node,
// written to every second like a heartbeat. The script runs past its module
// settling: until Ctrl+C, or for [seconds] then closes the socket and exits.
// With --no-interval, only the open socket keeps it running, until the
// server closes it after [seconds].
import net from "net";

const args = process.argv.filter((arg) => !arg.startsWith("-"));
const seconds = Number(args.at(-1)) || 0;
const withInterval = !process.argv.includes("--no-interval");

// Node's own net (not the core's): the server is not what keeps it running
const nodeNet = globalThis.process.getBuiltinModule("node:net");
const server = nodeNet.createServer((socket) => {
    socket.unref();
    socket.pipe(socket);
    if (!withInterval && seconds) {
        setTimeout(() => socket.end(), seconds * 1000).unref();
    }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();

const { port } = server.address() as { port: number };
const socket = net.connect(port, "127.0.0.1");
let echoes = 0;
socket.on("data", () => echoes++);
socket.on("close", () => console.log(`closed, echoes ${echoes}`));
await new Promise<void>((resolve) => socket.on("connect", resolve));
console.log("connected");

if (withInterval) {
    const start = Date.now();
    const interval = setInterval(() => {
        socket.write("ping");
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`alive ${elapsed}s, echoes ${echoes}`);
        if (seconds && elapsed >= seconds) {
            clearInterval(interval);
            socket.end();
        }
    }, 1000);
} else {
    socket.write("ping");
}
