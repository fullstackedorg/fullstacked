// Receives the results of bench cold-start run on other hosts and devices
// (bench cold-start --upload http://<this machine>:<port>/result/<name>):
// each POST is written to <dir>/<name>.json.
//
//   node test/bench/cold-start/receiver.ts <dir> [port, default 8765]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "cold-start-results");
const port = parseInt(process.argv[3] ?? "8765");
fs.mkdirSync(dir, { recursive: true });

http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/result\/([\w.-]+)$/);
    if (req.method !== "POST" || !match) {
        res.writeHead(404).end();
        return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        const file = path.join(dir, `${match[1]}.json`);
        fs.writeFileSync(file, Buffer.concat(chunks));
        console.log(`${new Date().toISOString()} ${file}`);
        res.writeHead(200).end("ok");
    });
}).listen(port, "0.0.0.0", () => console.log(`receiving on :${port} into ${dir}`));
