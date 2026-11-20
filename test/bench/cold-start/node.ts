// The cold-start bench of the Node CLI: from `fullstacked [--transform]` to
// the app's first render in a headless Chrome, for each fixture of the shell's
// bench cold-start (shell/cli/bench/cold-start-fixtures.ts), cold (no out/,
// no cached dependencies) then warm. Also `fullstacked -f` with a script
// importing React and lodash.
//
//   node test/bench/cold-start/node.ts [--dir <dir>] [--fixtures small,demo,heavy]
//                                      [--modes bundle,transform] [-r <warm runs>] [-o <file>]
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../../browser.ts";
import {
    FIXTURES,
    RENDER_PROBE,
    failedChecks,
    pluginsOf,
    type Fixture
} from "../../../shell/cli/bench/cold-start-fixtures.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repo, "platform/node/index.ts");

const args = process.argv.slice(2);
const option = (names: string[], fallback: string) => {
    const i = args.findIndex((a) => names.includes(a));
    return i === -1 ? fallback : args[i + 1];
};
const dir = path.resolve(
    option(["--dir"], path.join(repo, ".cache/cold-start"))
);
const fixtures = option(
    ["--fixtures"],
    FIXTURES.map((f) => f.name).join(",")
).split(",");
const modes = option(["--modes"], "bundle,transform").split(",");
const warmRuns = parseInt(option(["-r", "--runs"], "3"));
const output = option(["-o", "--output"], "");

function setUp(fixture: Fixture) {
    const fixtureDir = path.join(dir, fixture.name);
    if (!fs.existsSync(path.join(fixtureDir, fixture.entry))) {
        fs.mkdirSync(dir, { recursive: true });
        if (fixture.git) {
            execSync(`git clone -q ${fixture.git.url} ${fixture.name}`, {
                cwd: dir
            });
            execSync(`git checkout -q ${fixture.git.commit}`, {
                cwd: fixtureDir
            });
        } else {
            for (const [file, contents] of Object.entries(fixture.files)) {
                const target = path.join(fixtureDir, file);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, contents);
            }
        }
        const entry = path.join(fixtureDir, fixture.entry);
        // the modules fixture writes its own probe, with its checks
        if (fixture.name !== "modules") {
            fs.writeFileSync(
                entry,
                fs.readFileSync(entry, "utf-8") + RENDER_PROBE
            );
        }
    }
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "package.json"), "utf-8")
    );
    const hasPackages = Object.keys(packageJson.dependencies ?? {}).length > 0;
    if (hasPackages && !fs.existsSync(path.join(fixtureDir, "node_modules"))) {
        execSync("npm install --no-audit --no-fund", {
            cwd: fixtureDir,
            stdio: "ignore"
        });
    }
    return fixtureDir;
}

type Result = {
    fixture: string;
    mode: string;
    temp: string;
    readyMs?: number;
    renderMs?: number;
    requests?: number;
    error?: string;
};

const browser = await launchBrowser({ headless: true });

async function measure(
    fixture: Fixture,
    fixtureDir: string,
    mode: string,
    temp: string
): Promise<Result> {
    if (temp === "cold") {
        fs.rmSync(path.join(fixtureDir, "out"), {
            recursive: true,
            force: true
        });
        fs.rmSync(path.join(fixtureDir, "node_modules/.fullstacked"), {
            recursive: true,
            force: true
        });
    }
    const port = 9400 + Math.floor(Math.random() * 500);
    const cliArgs = [cli, "fullstacked", "-n", "--port", String(port)];
    if (mode === "transform") cliArgs.push("--transform");
    for (const p of pluginsOf(fixture)) cliArgs.push("-p", p);

    const page = await browser.newPage();
    const start = performance.now();
    const child = spawn("node", cliArgs, { cwd: fixtureDir });
    let out = "";
    try {
        await new Promise<void>((resolve, reject) => {
            child.stdout.on("data", (d) => {
                out += d;
                if (out.includes("Listening")) resolve();
            });
            child.stderr.on("data", (d) => (out += d));
            child.on("exit", () =>
                reject(new Error(out.trim().split("\n").at(-1)))
            );
        });
        const ready = performance.now();
        await page.goto(`http://localhost:${port}/`);
        await page.waitForSelector(fixture.selector, { timeout: 60000 });
        const render = performance.now();
        const checks = await page.evaluate(() => {
            const el = document.querySelector("#app");
            try {
                return JSON.parse(el?.textContent ?? "");
            } catch {
                return undefined;
            }
        });
        const failed = failedChecks(checks);
        if (failed.length) throw new Error(failed.join(", "));
        const requests = await page.evaluate(
            () => performance.getEntriesByType("resource").length
        );
        return {
            fixture: fixture.name,
            mode,
            temp,
            readyMs: Math.round(ready - start),
            renderMs: Math.round(render - start),
            requests
        };
    } catch (e) {
        return {
            fixture: fixture.name,
            mode,
            temp,
            error: (e as Error).message
        };
    } finally {
        await page.close();
        child.kill();
        await new Promise((r) => setTimeout(r, 300));
    }
}

// fullstacked -f: bundle, import, first output
function measureFile(): Result[] {
    const fixtureDir = setUp(FIXTURES.find((f) => f.name === "small"));
    if (!fs.existsSync(path.join(fixtureDir, "node_modules/lodash"))) {
        execSync("npm install --no-audit --no-fund lodash@4.17.21", {
            cwd: fixtureDir,
            stdio: "ignore"
        });
    }
    const script = path.join(fixtureDir, "script.ts");
    fs.writeFileSync(
        script,
        `import React from "react";\nimport _ from "lodash";\nconsole.log("ok", typeof React.createElement, typeof _.chunk);\n`
    );
    const results: Result[] = [];
    for (let i = 0; i <= warmRuns; i++) {
        const start = performance.now();
        const stdout = execSync(`node ${cli} fullstacked -f script.ts`, {
            cwd: fixtureDir
        }).toString();
        results.push({
            fixture: "file (react + lodash)",
            mode: "-f",
            temp: i === 0 ? "first" : "again",
            renderMs: Math.round(performance.now() - start),
            error: stdout.includes("ok function function") ? undefined : stdout
        });
    }
    return results;
}

const results: Result[] = [];
for (const name of fixtures) {
    const fixture = FIXTURES.find((f) => f.name === name);
    const fixtureDir = setUp(fixture);
    for (const mode of modes.filter(
        (m) => !fixture.modes || fixture.modes.includes(m as any)
    )) {
        for (let i = 0; i <= warmRuns; i++) {
            const r = await measure(
                fixture,
                fixtureDir,
                mode,
                i === 0 ? "cold" : "warm"
            );
            results.push(r);
            console.log(
                `${r.fixture.padEnd(8)}${r.mode.padEnd(11)}${r.temp.padEnd(6)}` +
                    (r.error
                        ? `ERROR ${r.error}`
                        : `ready ${String(r.readyMs).padStart(5)}ms  render ${String(r.renderMs).padStart(5)}ms  ${r.requests} requests`)
            );
        }
    }
}
for (const r of measureFile()) {
    results.push(r);
    console.log(
        `${r.fixture.padEnd(22)}${r.temp.padEnd(6)}${r.error ? "ERROR " + r.error : r.renderMs + "ms"}`
    );
}
await browser.close();

const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const table: string[] = [
    "| fixture | mode | temp | ready (ms) | first render (ms) | requests |",
    "| --- | --- | --- | --- | --- | --- |"
];
const keys = [
    ...new Set(results.map((r) => `${r.fixture}|${r.mode}|${r.temp}`))
];
for (const key of keys) {
    const same = results.filter(
        (r) => !r.error && `${r.fixture}|${r.mode}|${r.temp}` === key
    );
    if (!same.length) continue;
    const [fixture, mode, temp] = key.split("|");
    const ready =
        same[0].readyMs === undefined
            ? ""
            : String(median(same.map((r) => r.readyMs)));
    const requests =
        same[0].requests === undefined ? "" : String(same[0].requests);
    table.push(
        `| ${fixture} | ${mode} | ${temp} | ${ready} | ${median(same.map((r) => r.renderMs))} | ${requests} |`
    );
}
console.log("\nmedian\n" + table.join("\n"));

if (output) {
    const version = JSON.parse(
        fs.readFileSync(
            path.join(repo, "core/internal/bundle/lib/process/version.json"),
            "utf-8"
        )
    );
    fs.writeFileSync(
        output,
        JSON.stringify(
            {
                meta: {
                    platform: "node",
                    os: process.platform,
                    arch: process.arch,
                    commit: version.hash?.slice(0, 8),
                    date: new Date().toISOString()
                },
                results,
                table
            },
            null,
            2
        )
    );
}
process.exit(results.some((r) => r.error) ? 1 : 0);
