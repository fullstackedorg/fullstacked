// @ts-ignore
import tunnel from "tunnel";

// where our websocket tunnel proxy server listens, from
// test/tunnel/integration.ts
const port = parseInt(new URLSearchParams(location.search).get("port"));

tunnel
    .register({
        name: "my-fetch-tunnel",
        host: "localhost",
        port,
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
