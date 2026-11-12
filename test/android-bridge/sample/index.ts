import fs from "fs";
import { Worker } from "worker_threads";

// The sync reads of workers on a host whose workers read the response of
// their sync calls with GET /sync/{key} (Android, see ../host.ts): a worker
// reads a .wasm with readFileSync (lightningcss-wasm does) while the page
// made sync calls of its own, and keeps its thread busy (the page relays the
// worker's call once its thread is free, the worker reads at once).

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

function wasm(fill: number) {
    const data = new Uint8Array(64 * 1024).fill(fill);
    data.set(MAGIC);
    return data;
}

function busy(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) {}
}

function spawn() {
    const worker = new Worker("./worker.ts.js");
    const messages: ((data: any) => void)[] = [];
    worker.on("message", (event: MessageEvent) => {
        // the worker is about to read: the page's thread is busy meanwhile
        if (event.data?.reading) {
            busy(300);
            return;
        }
        messages.shift()?.(event.data);
    });
    const next = () => new Promise<any>((resolve) => messages.push(resolve));
    return { worker, ready: next(), next };
}

async function read(
    w: ReturnType<typeof spawn>,
    file: string
): Promise<{ file: string; head: string; size: number; fill: number }> {
    const result = w.next();
    w.worker.postMessage({ read: file });
    return result;
}

async function main() {
    const mode = new URLSearchParams(location.search).get("cases") ?? "all";

    await fs.promises.writeFile(".history", "ls\ncd demo\nnpm start\n");
    await fs.promises.writeFile("a.wasm", wasm(0xaa));
    await fs.promises.writeFile("b.wasm", wasm(0xbb));

    const results: Record<string, any> = {};

    // a worker reads after the page made sync calls with every id
    const w = spawn();
    await w.ready;
    for (let i = 0; i < 300; i++) {
        fs.readFileSync(".history");
    }
    results.afterPage = await read(w, "a.wasm");
    w.worker.terminate();

    // two workers read at the same time (their ids are the same)
    if (mode === "all") {
        const w1 = spawn();
        const w2 = spawn();
        await Promise.all([w1.ready, w2.ready]);
        results.twoWorkers = await Promise.all([
            read(w1, "a.wasm"),
            read(w2, "b.wasm")
        ]);
        w1.worker.terminate();
        w2.worker.terminate();
    }

    for (const file of [".history", "a.wasm", "b.wasm"]) {
        await fs.promises.rm(file);
    }
    return results;
}

main()
    .then((results) => {
        document.body.innerText = JSON.stringify(results);
    })
    .catch((e) => {
        document.body.innerText = JSON.stringify({ error: e.message });
    })
    .finally(() => document.body.classList.add("done"));
