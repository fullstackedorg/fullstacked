import dgram from "dgram";
import { Buffer } from "buffer";

const socket = dgram.createSocket("udp4");
socket.on("message", (msg) => {
    document.body.innerText = Buffer.from(msg).toString();
    socket.close();
    document.body.classList.add("done");
});

socket.bind(0, () => {
    // the test server's port, from test/dgram/integration.ts
    const port = parseInt(new URLSearchParams(location.search).get("port"));
    socket.send(Buffer.from("123"), port, "127.0.0.1");
});
