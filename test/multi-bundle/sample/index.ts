import fs from "fs";
import plugin from "fullstacked/plugin";
import { checks, flood, type Params } from "./checks.ts";

// The page's bundle. It imports a second bundle (second.ts.js, its own copy
// of the lib) and both use the bridge at the same time. test/multi-bundle
// reads the results in the body.

const search = new URLSearchParams(location.search);
const params: Params = { port: search.get("port"), git: search.get("git") };

// the ids of the calls on the transport: no two calls in flight share one
const transport = globalThis.fullstacked.platformBridge.bridge;
const inFlight = new Set<number>();
let collisions = 0;
let maxInFlight = 0;
const track = (payload: ArrayBuffer) => {
    const id = new Uint8Array(payload)[1];
    if (inFlight.has(id)) collisions++;
    inFlight.add(id);
    maxInFlight = Math.max(maxInFlight, inFlight.size);
    return id;
};
const transportAsync = transport.Async;
transport.Async = (payload) => {
    const id = track(payload);
    return transportAsync(payload).finally(() => inFlight.delete(id));
};
const transportSync = transport.Sync;
transport.Sync = (payload) => {
    const id = track(payload);
    try {
        return transportSync(payload);
    } finally {
        inFlight.delete(id);
    }
};

// the git test server's user (test/git/local-git-server), asked for the
// clones of both bundles: the second bundle's comes to this one's plugin
if (params.git) {
    await plugin.register("git-auth", {
        callback: () => ({ username: "test", password: "testing" })
    });
}

// not a literal: esbuild keeps the import, the bundle loads on its own
const secondUrl = new URL("./second.ts.js", location.href).href;
const second: typeof import("./second.ts") = await import(secondUrl);

const [first, other, worker] = await Promise.all([
    checks("first", params),
    second.checks("second", params),
    second.workerCheck()
]);
const flooded = await Promise.all([flood("first"), second.flood("second")]);

// a bundle of another bridge version must not load
let mismatch = "no shared bridge";
const shared = globalThis.fullstacked.__bridge;
if (shared) {
    const version = shared.version;
    shared.version = version + 1;
    try {
        await import(secondUrl + "?mismatch");
        mismatch = "loaded";
    } catch (e) {
        mismatch = e instanceof Error ? e.message : String(e);
    } finally {
        shared.version = version;
    }
}

// and the bridge still answers
const after = await fs.promises.readFile("tmp/first/fs/0.txt", "utf8");

await fs.promises.rm("tmp", { recursive: true });

document.body.textContent = JSON.stringify({
    first,
    second: other,
    worker,
    flooded,
    sameBridge: second.bridge === globalThis.fullstacked.bridge,
    collisions,
    maxInFlight,
    mismatch,
    after
});
document.body.classList.add("done");
