import "./build.ts";
import "./platform/node/build.ts";

import path from "node:path";
import fs from "node:fs";
import child_process from "node:child_process";

const directory = path.resolve(process.argv[2] || ".");
if (fs.existsSync(path.join(directory, "package.json"))) {
    child_process.execSync("npm run prestart", {
        cwd: directory,
        stdio: "inherit"
    });
}

await import("./platform/node/index.js");
