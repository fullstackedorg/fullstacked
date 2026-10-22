// Micro-benchmark of a net socket through the runtime, against plain Node:
//
//   npm run build && npm run build -w platform/node
//   node test/bench/net.ts [--modes node,runtime,tunnel] [--json]
//
// modes: node (node:net), runtime (lib/net, a TCP socket of the core),
// tunnel (lib/net through a tunnel, the core's WebSocket to a local hub)
//
// Every case talks to a local echo server (test/bench/servers.js):
// - rtt: sequential 64 B request / response, the added latency per call
// - echo 1 KB / 64 KB / 16 MB: sequential requests of that size, echoed
// - 16 MB in 1 KB writes: written back to back (a driver's pipelined
//   queries), echoed
// - 64 sockets: 64 connections at once, 4 MB each, echoed
// Throughput counts the bytes of one direction.

import "../../core/internal/bundle/lib/fullstacked/index.ts";
import { stop } from "../../platform/node/src/index.ts";
import netGo from "../../core/internal/bundle/lib/net/index.ts";
import tunnelGo from "../../core/internal/bundle/lib/tunnel/index.ts";
import net from "node:net";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

type Mode = "node" | "runtime" | "tunnel";

const args = process.argv.slice(2);
const modesArg = args[args.indexOf("--modes") + 1];
const modes: Mode[] =
    args.includes("--modes") && modesArg
        ? (modesArg.split(",") as Mode[])
        : ["node", "runtime", "tunnel"];
const json = args.includes("--json");

const servers = fork(fileURLToPath(new URL("./servers.js", import.meta.url)));
const { echoPort, hubPort } = await new Promise<{
    echoPort: number;
    hubPort: number;
}>((resolve) => servers.once("message", resolve as any));

const tunnelName = "bench-tunnel";
await tunnelGo.register({
    name: tunnelName,
    host: "127.0.0.1",
    port: hubPort,
    unsecure: true
});

type Socket = net.Socket | InstanceType<typeof netGo.Socket>;

function connect(mode: Mode): Promise<Socket> {
    return new Promise((resolve, reject) => {
        let socket: Socket;
        switch (mode) {
            case "node":
                socket = net.connect({
                    port: echoPort,
                    host: "127.0.0.1",
                    noDelay: true
                });
                break;
            case "runtime":
                socket = netGo.connect(echoPort, "127.0.0.1");
                break;
            case "tunnel":
                socket = netGo.connect(echoPort, tunnelName);
                break;
        }
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

// resolves once size bytes came back
function receive(socket: Socket, size: number) {
    return new Promise<void>((resolve, reject) => {
        let received = 0;
        const timeout = setTimeout(
            () => reject(new Error(`stalled at ${received}/${size} bytes`)),
            60_000
        );
        const onData = (chunk: Uint8Array) => {
            received += chunk.byteLength;
            if (received >= size) {
                clearTimeout(timeout);
                socket.off("data", onData);
                resolve();
            }
        };
        socket.on("data", onData);
    });
}

async function close(socket: Socket) {
    await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.destroy();
    });
}

const payloadCache = new Map<number, Buffer>();
function payload(size: number) {
    let data = payloadCache.get(size);
    if (!data) {
        data = Buffer.alloc(size);
        for (let i = 0; i < size; i++) data[i] = i % 251;
        payloadCache.set(size, data);
    }
    return data;
}

async function rtt(mode: Mode, iterations: number) {
    const socket = await connect(mode);
    const data = payload(64);
    const times: number[] = [];
    // warm up
    for (let i = 0; i < 50; i++) {
        const done = receive(socket, data.byteLength);
        socket.write(data);
        await done;
    }
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const done = receive(socket, data.byteLength);
        socket.write(data);
        await done;
        times.push(performance.now() - start);
    }
    await close(socket);
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return {
        meanUs: mean * 1000,
        p50Us: times[Math.floor(times.length * 0.5)] * 1000,
        p99Us: times[Math.floor(times.length * 0.99)] * 1000
    };
}

// sequential requests of size bytes, MB/s of one direction
async function echo(mode: Mode, size: number, iterations: number) {
    const socket = await connect(mode);
    const data = payload(size);
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        const done = receive(socket, size);
        socket.write(data);
        await done;
    }
    const ms = performance.now() - start;
    await close(socket);
    return {
        mbps: (size * iterations) / 1e6 / (ms / 1000),
        reqps: iterations / (ms / 1000)
    };
}

// size bytes in writes of chunkSize, back to back
async function smallWrites(mode: Mode, size: number, chunkSize: number) {
    const socket = await connect(mode);
    const chunk = payload(chunkSize);
    const start = performance.now();
    const done = receive(socket, size);
    for (let sent = 0; sent < size; sent += chunkSize) {
        socket.write(chunk);
    }
    await done;
    const ms = performance.now() - start;
    await close(socket);
    return { mbps: size / 1e6 / (ms / 1000) };
}

async function parallel(mode: Mode, sockets: number, size: number) {
    const connected = await Promise.all(
        Array.from({ length: sockets }, () => connect(mode))
    );
    const data = payload(size);
    const start = performance.now();
    await Promise.all(
        connected.map((socket) => {
            const done = receive(socket, size);
            socket.write(data);
            return done;
        })
    );
    const ms = performance.now() - start;
    await Promise.all(connected.map(close));
    return { mbps: (size * sockets) / 1e6 / (ms / 1000) };
}

const KB = 1024;
const MB = 1024 * 1024;

const results: Record<string, Record<string, any>> = {};

for (const mode of modes) {
    const r: Record<string, any> = {};
    r.rtt64 = await rtt(mode, 2000);
    r.echo1KB = await echo(mode, KB, 2000);
    r.echo64KB = await echo(mode, 64 * KB, 200);
    r.echo16MB = await echo(mode, 16 * MB, 3);
    r.writes1KB = await smallWrites(mode, 16 * MB, KB);
    r.parallel64 = await parallel(mode, 64, 4 * MB);
    results[mode] = r;
}

const f = (n: number) => n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0);

if (json) {
    console.log(JSON.stringify(results));
} else {
    const rows: [string, (r: Record<string, any>) => string][] = [
        ["rtt 64 B mean (us)", (r) => f(r.rtt64.meanUs)],
        ["rtt 64 B p50 (us)", (r) => f(r.rtt64.p50Us)],
        ["rtt 64 B p99 (us)", (r) => f(r.rtt64.p99Us)],
        ["echo 1 KB (req/s)", (r) => f(r.echo1KB.reqps)],
        ["echo 1 KB (MB/s)", (r) => f(r.echo1KB.mbps)],
        ["echo 64 KB (MB/s)", (r) => f(r.echo64KB.mbps)],
        ["echo 16 MB (MB/s)", (r) => f(r.echo16MB.mbps)],
        ["16 MB in 1 KB writes (MB/s)", (r) => f(r.writes1KB.mbps)],
        ["64 sockets x 4 MB (MB/s)", (r) => f(r.parallel64.mbps)]
    ];
    const header = ["", ...modes];
    const table = [
        header,
        ...rows.map(([label, value]) => [
            label,
            ...modes.map((m) => value(results[m]))
        ])
    ];
    const widths = header.map((_, i) =>
        Math.max(...table.map((row) => row[i].length))
    );
    for (const row of table) {
        console.log(
            row
                .map((cell, i) =>
                    i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])
                )
                .join("  ")
        );
    }
}

servers.kill();
stop();
process.exit(0);
