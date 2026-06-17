import net from "net";

const socket = new net.Socket();
socket.on("connect", () => {
    socket.write(new Uint8Array([1, 2, 3]));
    setTimeout(socket.destroy.bind(socket), 300);
});
socket.on("data", (chunk: Uint8Array) => {
    document.body.innerText += chunk.join("").toString();
});
socket.on("close", () => {
    document.body.classList.add("done");
});
socket.connect(9090);
