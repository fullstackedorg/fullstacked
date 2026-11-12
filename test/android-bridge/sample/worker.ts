import fs from "fs";
import { parentPort } from "worker_threads";

const hex = (data: Uint8Array) =>
    Array.from(data.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

parentPort.on("message", (event: MessageEvent) => {
    const file = event.data?.read;
    if (!file) return;
    // the page's thread is busy once it got this message, the sync call
    // below is relayed after
    parentPort.postMessage({ reading: true });
    let result: any;
    try {
        const data: Uint8Array = fs.readFileSync(file);
        result = {
            file,
            head: hex(data),
            size: data.byteLength,
            fill: data[data.byteLength - 1]
        };
    } catch (e) {
        result = { file, error: e.message };
    }
    parentPort.postMessage(result);
});

parentPort.postMessage({ ready: true });
