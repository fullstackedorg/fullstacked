import assert from "node:assert";

// Verify WebSocket is available in the global scope
assert.ok(
    typeof WebSocket !== "undefined",
    "WebSocket should be in global scope"
);

// Verify original WebSocket is preserved on window.fullstacked / globalThis.fullstacked
const fullstackedObj =
    (globalThis as any).fullstacked || (globalThis as any).window?.fullstacked;
assert.ok(fullstackedObj, "fullstacked object should exist");
assert.ok(
    fullstackedObj.WebSocket,
    "original WebSocket should exist on fullstacked"
);

// Connect to test server using global WebSocket
const ws = new WebSocket("ws://localhost:9092");

await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
        ws.send("sample-from-execute");
    };
    ws.onmessage = (event) => {
        assert.equal(event.data, "sample-from-execute");
        ws.close(1000, "done");
    };
    ws.onclose = () => {
        resolve();
    };
    ws.onerror = (err) => {
        reject(err);
    };
});
