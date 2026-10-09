// Receives bench results uploaded from devices with the shell's curl, and
// serves the results viewer (perfs/viewer) at http://localhost:<port>/.
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
const viewerDirectory = path.resolve(currentDirectory, "viewer");
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

const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json"
};

// stages and platform files under perfs/bench, for the viewer
function benchIndex() {
    if (!fs.existsSync(benchDirectory)) return { stages: [] };
    const stages = fs
        .readdirSync(benchDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const [stage, commit] = entry.name.split("-");
            const files = fs
                .readdirSync(path.join(benchDirectory, entry.name))
                .filter((file) => file.endsWith(".json"))
                .sort();
            return { id: entry.name, stage, commit: commit ?? "", files };
        })
        .filter((stage) => stage.files.length > 0);
    return { stages };
}

function resolveStatic(requestUrl: string) {
    const pathname = decodeURIComponent(
        new URL(requestUrl, "http://localhost").pathname
    );
    if (pathname === "/" || pathname === "/index.html") {
        return path.join(viewerDirectory, "index.html");
    }
    const root = pathname.startsWith("/bench/")
        ? benchDirectory
        : pathname.startsWith("/viewer/")
          ? viewerDirectory
          : null;
    if (!root) return null;
    const target = path.resolve(root, "." + pathname.replace(/^\/[^/]+/, ""));
    if (!target.startsWith(root + path.sep)) return null;
    return target;
}

function serveGet(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/bench/index.json") {
        res.writeHead(200, {
            "Content-Type": mimeTypes[".json"],
            "Cache-Control": "no-store"
        });
        return res.end(JSON.stringify(benchIndex()));
    }
    const target = resolveStatic(req.url ?? "/");
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found\n");
    }
    res.writeHead(200, {
        "Content-Type":
            mimeTypes[path.extname(target)] ?? "application/octet-stream",
        "Cache-Control": "no-store"
    });
    fs.createReadStream(target).pipe(res);
}

const server = http.createServer((req, res) => {
    const reply = (status: number, message: string) => {
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(message + "\n");
    };

    if (req.method === "GET" || req.method === "HEAD") {
        return serveGet(req, res);
    }

    if (req.method !== "POST" && req.method !== "PUT") {
        return reply(405, "use GET, POST or PUT");
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
            let body = Buffer.concat(chunks);
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
                `${new Date().toLocaleTimeString()} ${req.socket.remoteAddress} rejected ${req.url}: ${e.message}`
            );
            reply(400, e.message);
        }
    });
});

server.listen(port, "0.0.0.0", () => {
    const addresses = privateAddresses();
    console.log(
        `Receiving bench results into ${path.relative(process.cwd(), benchDirectory) || "."}`
    );
    console.log(`Results viewer at http://localhost:${port}/`);
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
