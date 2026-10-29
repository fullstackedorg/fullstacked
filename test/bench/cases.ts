// The cases of the net bench (test/bench/net.ts under Node, test/bench/app.ts
// bundled and run by the CLI), against the echo server of
// test/bench/servers.js. Throughput counts the bytes of one direction.

export interface Socket {
    write(data: Uint8Array, callback?: () => void): unknown;
    on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
    off(event: "data", cb: (chunk: Uint8Array) => void): unknown;
    once(event: string, cb: (...args: any[]) => void): unknown;
    destroy(): unknown;
}

// echo: the echo server, slow: the slow sink
export type Connect = (target?: "echo" | "slow") => Promise<Socket>;

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

async function rtt(connect: Connect, iterations: number) {
    const socket = await connect();
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
async function echo(connect: Connect, size: number, iterations: number) {
    const socket = await connect();
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
async function smallWrites(connect: Connect, size: number, chunkSize: number) {
    const socket = await connect();
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

async function parallel(connect: Connect, sockets: number, size: number) {
    const connected = await Promise.all(
        Array.from({ length: sockets }, () => connect())
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

// round trips on one socket while another uploads to a peer slow to take
// it: what one upload does to every other socket
async function rttDuringUpload(connect: Connect, uploadSize: number) {
    const socket = await connect();
    const upload = await connect("slow");
    const data = payload(64);
    const uploadData = payload(uploadSize);
    const times: number[] = [];

    let uploading = true;
    let uploaded: Promise<void>;
    let start = 0;
    while (uploading && times.length < 100000) {
        const t = performance.now();
        // in a timed round trip: a write call that waits for the peer
        // shows as a long one
        if (times.length === 20) {
            start = t;
            uploaded = new Promise<void>((resolve) =>
                upload.write(uploadData, () => {
                    uploading = false;
                    resolve();
                })
            );
        }
        const done = receive(socket, data.byteLength);
        socket.write(data);
        await done;
        times.push(performance.now() - t);
    }
    await uploaded;
    const uploadMs = performance.now() - start;
    await Promise.all([close(socket), close(upload)]);

    times.sort((a, b) => a - b);
    return {
        uploadMs,
        roundTrips: times.length,
        p50Us: times[Math.floor(times.length * 0.5)] * 1000,
        maxUs: times[times.length - 1] * 1000
    };
}

const KB = 1024;
const MB = 1024 * 1024;

export async function bench(connect: Connect) {
    return {
        rtt64: await rtt(connect, 2000),
        echo1KB: await echo(connect, KB, 2000),
        echo64KB: await echo(connect, 64 * KB, 200),
        echo16MB: await echo(connect, 16 * MB, 3),
        writes1KB: await smallWrites(connect, 16 * MB, KB),
        parallel64: await parallel(connect, 64, 4 * MB),
        duringUpload: await rttDuringUpload(connect, 32 * MB)
    };
}

export function print(
    results: Record<string, Awaited<ReturnType<typeof bench>>>,
    json: boolean
) {
    const modes = Object.keys(results);
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
            ["64 sockets x 4 MB (MB/s)", (r) => f(r.parallel64.mbps)],
            [
                "round trips during a 32 MB slow upload",
                (r) => f(r.duringUpload.roundTrips)
            ],
            ["  their p50 (us)", (r) => f(r.duringUpload.p50Us)],
            ["  their max (us)", (r) => f(r.duringUpload.maxUs)]
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
                        i === 0
                            ? cell.padEnd(widths[i])
                            : cell.padStart(widths[i])
                    )
                    .join("  ")
            );
        }
    }
}
