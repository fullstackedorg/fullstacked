import dgram from "dgram";
import { Buffer } from "buffer";

const socket = dgram.createSocket("udp4");
socket.on("message", (msg) => {
    document.body.innerText = Buffer.from(msg).toString();
    document.body.classList.add("done");
});

socket.bind(0, () => {
    socket.send(Buffer.from("123"), 9091, "127.0.0.1");
});
