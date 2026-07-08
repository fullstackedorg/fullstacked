import "./build.ts";
import "./platform/node/build.ts";
import fs from "node:fs";
import child_process from "node:child_process";
import { getVersion } from "./version.ts";

if (fs.existsSync("app/shell/package.json")) {
    child_process.execSync(
        "node --experimental-strip-types app/shell/prestart.ts",
        {
            stdio: "inherit"
        }
    );

    await fs.promises.rm("app/out", { recursive: true, force: true });
    await fs.promises.rename("out", "app/out");

    const shellVersion = getVersion("app/shell");
    await fs.promises.writeFile(
        "app/out/.build",
        `${shellVersion.major}.${shellVersion.minor}.${shellVersion.patch}, branch ${shellVersion.branch}, hash ${shellVersion.hash.substring(0, 8)}`
    );
}

await import("./platform/node/index.js");
