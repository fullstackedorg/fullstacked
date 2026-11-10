import { parentPort } from "worker_threads";
import fs from "fs";

// started by the second bundle of the page (second.ts)
const port = new URLSearchParams(self.location.search).get("port");
const files = Array.from({ length: 50 }, (_, i) => i);

try {
    await fs.promises.mkdir("tmp/worker", { recursive: true });
    await Promise.all(
        files.map((i) => fs.promises.writeFile(`tmp/worker/${i}.txt`, `${i}`))
    );
    const contents = await Promise.all(
        files.map((i) => fs.promises.readFile(`tmp/worker/${i}.txt`, "utf8"))
    );
    contents.forEach((content, i) => {
        if (content !== `${i}`) throw new Error(`${i}.txt: got ${content}`);
    });
    const streamed = await fetch(`http://localhost:${port}/stream`, {
        headers: { "x-wait": "10" }
    });
    const text = await streamed.text();
    if (text !== "chunk".repeat(10)) throw new Error(`stream: got ${text}`);
    parentPort.postMessage({ result: "ok" });
} catch (e) {
    parentPort.postMessage({
        result: e instanceof Error ? e.message : String(e)
    });
}
