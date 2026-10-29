import DOMPurify from "dompurify";
import { Worker } from "worker_threads";
import { COMMON, PAYLOADS, sanitizeAll, unsafeParts } from "../corpus.ts";

// DOMPurify on the browser's DOM here, on lib/DOMParser's in a worker; the
// body gets both results and what of the worker's output the browser
// would run
const cases = [...COMMON, ...PAYLOADS];
const browser = sanitizeAll(DOMPurify, cases);

function done(report: unknown) {
    document.body.innerText = JSON.stringify(report);
    document.body.classList.add("done");
}

const worker = new Worker("./worker.ts.js");
worker.on("message", (event: any) => {
    const data = event.data;
    if (data.error) return done({ error: data.error });
    const unsafe: Record<string, string[]> = {};
    for (const c of PAYLOADS) {
        const found = unsafeParts(data.results[c.name], DOMParser);
        if (found.length) unsafe[c.name] = found;
    }
    done({
        supported: data.supported,
        browser,
        worker: data.results,
        unsafe
    });
});
worker.on("error", (e: any) => done({ error: e?.message ?? String(e) }));

// for test/dompurify's check of the fullstacked --file results
(globalThis as any).unsafeParts = (html: string) =>
    unsafeParts(html, DOMParser);
