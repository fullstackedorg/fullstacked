import core from "./core.ts";
import { after, before } from "node:test";

before(core.start);

let tests = [
    "./serialization/index.ts",
    "./path/index.ts",
    "./os/index.ts",
    "./fs/index.ts",
    "./static-file/index.ts",
    "./bundle/index.ts",
    "./stream/index.ts",
    "./events/index.ts",
    "./fetch/index.ts",
    "./net/index.ts",
    "./dns/index.ts",
    "./git/index.ts",
    "./packages/index.ts"
];
if (process.argv.length > 2) {
    tests = process.argv.slice(2).map((test) => "." + test.replace("test", ""));
}

for (const test of tests) {
    await import(test);
}

// hangs if C++ callback not released
after(core.instance.end);
