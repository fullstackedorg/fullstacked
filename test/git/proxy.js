import http from "node:http";
import net from "node:net";

const server = http.createServer((req, res) => {
    if (req.headers["x-test-header"] === "test-value") {
        if (process.send) {
            process.send("header-checked");
        }
    }
    let url;
    if (req.url.startsWith("/")) {
        url = new URL(
            req.url,
            `http://${req.headers["x-proxy-host"] || req.headers.host || "localhost"}`
        );
    } else {
        url = new URL(req.url);
    }
    const headers = { ...req.headers };
    if (req.headers["x-proxy-host"]) {
        headers["host"] = req.headers["x-proxy-host"];
        delete headers["x-proxy-host"];
    }
    headers["connection"] = "close";
    const proxyReq = http.request(
        {
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            method: req.method,
            headers
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            if (req.method === "HEAD") {
                res.end();
            } else {
                proxyRes.pipe(res);
            }
        }
    );
    proxyReq.on("error", (err) => {
        res.writeHead(502);
        res.end();
    });
    if (
        req.method === "POST" ||
        req.method === "PUT" ||
        req.method === "PATCH"
    ) {
        req.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
});

server.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", (err) => {
        // ignore clientSocket errors
    });
    if (req.headers["x-test-header"] === "test-value") {
        if (process.send) {
            process.send("header-checked");
        }
    }
    const parts = req.url.split(":");
    const host = parts[0];
    const port = parseInt(parts[1], 10) || 80;
    const serverSocket = net.connect(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", (err) => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
    });
});

server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    if (process.send) {
        process.send(`ready:${port}`);
    }
});
