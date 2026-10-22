import "../core/internal/bundle/lib/fullstacked/index.ts";
import { after } from "node:test";
import fs from "node:fs";
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
    "./timers/index.ts",
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
    "./config/index.ts",
    "./deeplink/index.ts",
    "./fullstacked/index.ts",
    "./shim/index.ts",
    "./dompurify/index.ts",
    ...pluginTests()
];

// A plugin's tests live in its own repository (plugins/<name>/test/index.ts):
// they run when the submodule is checked out, and are skipped when it is not.
function pluginTests() {
    const plugins = new URL("../plugins/", import.meta.url);
    if (!fs.existsSync(plugins)) return [];
    return fs
        .readdirSync(plugins)
        .map((name) => `../plugins/${name}/test/index.ts`)
        .filter((test) => fs.existsSync(new URL(test, import.meta.url)));
}

const definedTests = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--") && arg !== "test");
if (definedTests.length > 0) {
    tests = definedTests.map((test) => {
        // plugins/<name>/test is a plugin's own suite, outside test/
        let t = test.startsWith("plugins/")
            ? "../" + test
            : "." + test.replace(/^test/, "");
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
