// @ts-ignore
import tunnel from "tunnel";

// Port 9093 is where our websocket tunnel proxy server will be listening
tunnel
    .register({
        name: "my-fetch-tunnel",
        host: "localhost",
        port: 9093,
        unsecure: true
    })
    .then(() => {
        fetch("http://my-fetch-tunnel/")
            .then((resp) => resp.text())
            .then((text) => {
                document.body.innerText = text;
                document.body.classList.add("done");
            });
    });
