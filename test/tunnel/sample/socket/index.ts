import net from "net";
// @ts-ignore
import tunnel from "tunnel";

// Port 9091 is where our websocket tunnel proxy server will be listening
tunnel
    .register({
        name: "my-test-tunnel",
        host: "localhost",
        port: 9091,
        unsecure: true
    })
    .then(() => {
        const socket = new net.Socket();
        socket.on("connect", () => {
            socket.write(new Uint8Array([7, 8, 9]));
        });
        socket.on("data", (chunk: Uint8Array) => {
            document.body.innerText += chunk.join("").toString();
            if (document.body.innerText.trim().length >= 3) {
                socket.destroy();
            }
        });
        socket.on("close", () => {
            document.body.classList.add("done");
        });
        // The second argument is our registered tunnel hostname
        socket.connect(9090, "my-test-tunnel");
    });
