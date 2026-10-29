import fs from "node:fs";

export function cleanup() {
    fs.rmSync("test/bundle/samples/basic/out", {
        force: true,
        recursive: true
    });
    fs.rmSync("test/bundle/samples/file/index.ts.js", { force: true });
    fs.rmSync("test/bundle/samples/css/out", { force: true, recursive: true });
    fs.rmSync("test/bundle/samples/browser-only/out", {
        force: true,
        recursive: true
    });
}
