import "../core/internal/bundle/lib/fullstacked/index.ts";
import { after } from "node:test";
import { URL } from "node:url";
import { stop } from "../platform/node/src/index.ts";

process.env.TEST = "1";

let tests = [
    "./serialization/index.ts",
    "./path/index.ts",
    "./os/index.ts",
    "./fs/index.ts",
    "./url/index.ts",
    "./static-file/index.ts",
    "./bundle/index.ts",
    "./stream/index.ts",
    "./events/index.ts",
    "./fetch/index.ts",
    "./websocket/index.ts",
    "./net/index.ts",
    "./tunnel/index.ts",
    "./dgram/index.ts",
    "./dns/index.ts",
    "./git/index.ts",
    "./packages/index.ts",
    "./worker/index.ts",
    "./readline/index.ts",
    "./fullstacked/index.ts"
];

const definedTests = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--") && arg !== "test");
if (definedTests.length > 0) {
    tests = definedTests.map((test) => {
        let t = "." + test.replace(/^test/, "");
        if (!t.endsWith(".ts")) {
            if (!t.endsWith("/")) t += "/";
            t += "index.ts";
        }
        return t;
    });
}

for (const test of tests) {
    const url = new URL(test, import.meta.url);
    await import(url.toString());
}

// hangs if C++ callback not released
after(stop);
