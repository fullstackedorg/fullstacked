import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import { fetch as goFetch } from "../../lib/fetch/index.ts";
import { Worker } from "node:worker_threads";

function startServer() {
    return new Promise<Worker>((res) => {
        const worker = new Worker("./test/fetch/server.js");
        worker.on("message", () => res(worker));
        worker.on("error", console.log);
    });
}

suite("fetch - e2e", () => {
    let worker: Worker = null;
    before(async () => {
        worker = await startServer();
    });

    test("head", async () => {
        const responseNode = await fetch("http://localhost:9000");
        const responseGo = await goFetch("http://localhost:9000");
        assert.deepEqual(responseGo.ok, responseGo.ok)
        assert.ok(!!responseNode.headers.get("x-header-test"))
        assert.deepEqual(responseGo.headers.get("x-header-test"), responseGo.headers.get("x-header-test"))
        assert.deepEqual(responseGo.status, responseGo.status)
        assert.deepEqual(responseGo.statusText, responseGo.statusText)
    });

    after(async () => {
        worker.terminate();
    });
});
