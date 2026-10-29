import { parentPort } from "worker_threads";
import { COMMON, PAYLOADS, sanitizeAll } from "../corpus.ts";
import { purifyWithoutWindow } from "./purify.ts";

try {
    const purify = purifyWithoutWindow();
    parentPort.postMessage({
        supported: purify.isSupported,
        results: sanitizeAll(purify, [...COMMON, ...PAYLOADS])
    });
} catch (e) {
    parentPort.postMessage({ error: (e as Error).stack ?? String(e) });
}
