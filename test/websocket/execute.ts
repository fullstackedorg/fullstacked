import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import fullstacked from "../../core/internal/bundle/lib/fullstacked/index.ts";
import { startServer } from "./server.ts";
import { Worker } from "node:worker_threads";

suite("websocket - execute", () => {
    let worker: Worker = null;

    before(async () => {
        worker = await startServer();
    });

    test("execute file provides WebSocket in global scope", async () => {
        const exitCode = await fullstacked.execute([
            "fullstacked",
            "-f",
            "test/websocket/sample.ts"
        ]);
        assert.equal(exitCode, 0, "execute should exit with code 0");
    });

    after(() => {
        worker.terminate();
    });
});
