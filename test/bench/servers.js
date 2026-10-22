// Targets of the net bench (test/bench/net.ts), in their own process so the
// bench's event loop only runs the client:
// - a TCP echo server
// - a tunnel hub stand-in: one WebSocket per connection, piped to the echo
//   server, one binary message per socket read (like the FullStacked hub)
import net from "node:net";
import { WebSocketServer } from "ws";

const echo = net.createServer({ noDelay: true }, (socket) => {
    socket.on("data", (data) => socket.write(data));
    socket.on("error", () => {});
});

await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
const echoPort = echo.address().port;

const hub = new WebSocketServer({ port: 0, host: "127.0.0.1" });
hub.on("connection", (ws) => {
    const target = net.connect({
        port: echoPort,
        host: "127.0.0.1",
        noDelay: true
    });
    const queued = [];
    target.on("connect", () => {
        queued.forEach((data) => target.write(data));
        queued.length = 0;
    });
    ws.on("message", (data) => {
        if (target.connecting) queued.push(data);
        else target.write(data);
    });
    target.on("data", (data) => ws.send(data, { binary: true }));
    ws.on("close", () => target.destroy());
    target.on("close", () => ws.close());
    ws.on("error", () => target.destroy());
    target.on("error", () => ws.close());
});
await new Promise((resolve) => hub.on("listening", resolve));

process.send({ echoPort, hubPort: hub.address().port });
