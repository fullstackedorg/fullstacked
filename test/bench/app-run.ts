// Runs test/bench/app.ts with a fullstacked CLI, the way apps run:
//
//   node test/bench/app-run.ts [path to the CLI's index.js / index.ts] [--json]
//
// defaults to this checkout's platform/node/index.ts (build it first)
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli =
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    path.join(root, "platform/node/index.ts");

const servers = fork(fileURLToPath(new URL("./servers.js", import.meta.url)));
const { echoPort, slowPort, hubPort } = await new Promise<any>((resolve) =>
    servers.once("message", resolve)
);

const result = spawnSync(
    process.execPath,
    [path.resolve(cli), "fullstacked", "--file", "test/bench/app.ts"],
    {
        cwd: root,
        stdio: "inherit",
        env: {
            ...process.env,
            BENCH_PORTS: `${echoPort},${slowPort},${hubPort}`,
            BENCH_JSON: process.argv.includes("--json") ? "1" : "0"
        }
    }
);

servers.kill();
process.exit(result.status ?? 1);
