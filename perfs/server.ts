// Receives bench results uploaded from devices with the shell's curl.
// The results viewer is a FullStacked project: `npm start -- fullstacked perfs`.
//
//   node perfs/server.ts [port]
//
// The request path is where the file is saved under perfs/bench:
//   curl --data-binary @output.json http://<ip>:8000/stage1-5ffcd9c6/android.json
//   curl -T output.json http://<ip>:8000/stage1-5ffcd9c6/android.json
//   curl -F file=@output.json http://<ip>:8000/stage1-5ffcd9c6/android.json

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const benchDirectory = path.resolve(currentDirectory, "bench");
const port = parseInt(process.argv[2] ?? process.env.PORT ?? "8000");
const maxBodySize = 50 * 1024 * 1024;

function isPrivateIPv4(address: string) {
    const [a, b] = address.split(".").map(Number);
    return (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function privateAddresses() {
    const addresses: { name: string; address: string }[] = [];
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
        for (const info of infos ?? []) {
            if (
                info.family === "IPv4" &&
                !info.internal &&
                isPrivateIPv4(info.address)
            ) {
                addresses.push({ name, address: info.address });
            }
        }
    }
    return addresses;
}

// extract the first file part of a multipart/form-data body (curl -F)
function multipartFile(body: Buffer, contentType: string) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundary) {
        throw new Error("multipart body without boundary");
    }
    const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
    let start = body.indexOf(delimiter);
    while (start !== -1) {
        const headersEnd = body.indexOf("\r\n\r\n", start);
        const next = body.indexOf(delimiter, start + delimiter.length);
        if (headersEnd === -1 || next === -1) break;
        const headers = body.subarray(start, headersEnd).toString();
        if (/filename=/i.test(headers)) {
            // part content ends with \r\n before the next delimiter
            return body.subarray(headersEnd + 4, next - 2);
        }
        start = next;
    }
    throw new Error("no file part in multipart body");
}

function resolveTarget(requestUrl: string) {
    let pathname = decodeURIComponent(
        new URL(requestUrl, "http://localhost").pathname
    );
    if (pathname.endsWith("/")) {
        pathname += "output.json";
    }
    const target = path.resolve(benchDirectory, "." + pathname);
    if (!target.startsWith(benchDirectory + path.sep)) {
        throw new Error("path outside of perfs/bench");
    }
    return target;
}

const server = http.createServer((req, res) => {
    const reply = (status: number, message: string) => {
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(message + "\n");
    };

    if (req.method !== "POST" && req.method !== "PUT") {
        return reply(405, "use POST or PUT");
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBodySize) {
            reply(413, "body too large");
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on("end", () => {
        if (res.writableEnded) return;
        try {
            const target = resolveTarget(req.url ?? "/");
            const contentType = req.headers["content-type"] ?? "";
            let body: Buffer = Buffer.concat(chunks);
            if (contentType.startsWith("multipart/form-data")) {
                body = multipartFile(body, contentType);
            }

            // bench results only, reject anything that isn't JSON
            JSON.parse(body.toString());

            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, body);
            const relative = path.relative(process.cwd(), target);
            console.log(
                `${new Date().toLocaleTimeString()} ${req.socket.remoteAddress} saved ${relative} (${body.length} bytes)`
            );
            reply(200, `saved ${relative}`);
        } catch (e) {
            console.log(
                `${new Date().toLocaleTimeString()} ${req.socket.remoteAddress} rejected ${req.url}: ${(e as Error).message}`
            );
            reply(400, (e as Error).message);
        }
    });
});

server.listen(port, "0.0.0.0", () => {
    const addresses = privateAddresses();
    console.log(
        `Receiving bench results into ${path.relative(process.cwd(), benchDirectory) || "."}`
    );
    if (addresses.length === 0) {
        console.log(`No private IPv4 address found, listening on port ${port}`);
    }
    for (const { name, address } of addresses) {
        console.log(`  http://${address}:${port} (${name})`);
    }
    const example = addresses[0]?.address ?? "<ip>";
    console.log("\nFrom the FullStacked shell on the device:");
    console.log(
        `  curl --data-binary @output.json http://${example}:${port}/stage1-<commit>/<platform>.json`
    );
});
