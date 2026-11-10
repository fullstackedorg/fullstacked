import fs from "fs";
import git from "fullstacked/git";
import packages from "fullstacked/packages";
import run from "fullstacked/run";

// Bundled in both bundles of the page: each bundle has its own copy of
// fs, git, packages and run, and makes the same calls as the other at the
// same time. Every answer must reach the bundle that asked.

export type Params = {
    // the fetch test server (test/fetch/server-fetch.js)
    port: string;
    // the git test server (test/git/server.ts), none without Docker
    git: string | null;
};

export type Results = {
    // "ok" or the error of each check
    checks: Record<string, string>;
    // the context run created
    ctx: number;
};

const te = new TextEncoder();

const FILES = 20;

// async calls in flight per bundle, together more than the 255 ids of the
// page. A sync call throws while all ids are taken, so nothing else runs.
const FLOOD = 200;

function expect(name: string, actual: unknown, expected: unknown) {
    if (actual !== expected) {
        throw new Error(
            `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

export async function checks(label: string, params: Params) {
    const dir = `tmp/${label}`;
    await fs.promises.mkdir(dir, { recursive: true });

    const results: Results = { checks: {}, ctx: 0 };
    const check = async (name: string, fn: () => Promise<void>) => {
        try {
            await fn();
            results.checks[name] = "ok";
        } catch (e) {
            results.checks[name] = e instanceof Error ? e.message : String(e);
        }
    };

    await Promise.all([
        check("fs", () => writeAndRead(`${dir}/fs`, label, FILES)),
        check("fetch", async () => {
            const echo = await fetch(`http://localhost:${params.port}`, {
                method: "POST",
                body: te.encode(label)
            });
            expect("echo", await echo.text(), label);
            // a body streamed in chunks, while the other bundle reads its own
            const streamed = await fetch(
                `http://localhost:${params.port}/stream`,
                { headers: { "x-wait": "10" } }
            );
            expect("stream", await streamed.text(), "chunk".repeat(10));
        }),
        check("git.clone", async () => {
            if (!params.git) return;
            const duplex = await git.clone(`${params.git}/test`, `${dir}/git`);
            await duplex.promise();
            expect(
                "test.txt",
                await fs.promises.readFile(`${dir}/git/test.txt`, "utf8"),
                "test file\n"
            );
        }),
        check("packages.install", async () => {
            const directory = `${dir}/packages`;
            await fs.promises.mkdir(directory, { recursive: true });
            await fs.promises.writeFile(
                `${directory}/package.json`,
                JSON.stringify({ name: label })
            );
            const install = await packages.install(directory, false, "react");
            let progress = 0;
            install.on("progress", () => progress++);
            await new Promise<void>((resolve, reject) => {
                install.duplex.on("error", reject);
                install.duplex.on("close", resolve);
            });
            if (progress === 0) throw new Error("no progress event");
            const manifest = JSON.parse(
                await fs.promises.readFile(
                    `${directory}/node_modules/react/package.json`,
                    "utf8"
                )
            );
            expect("react", manifest.name, "react");
        }),
        check("run", async () => {
            results.ctx = await run(dir);
            if (!Number.isInteger(results.ctx) || results.ctx <= 0) {
                throw new Error(`no context: ${results.ctx}`);
            }
        })
    ]);

    return results;
}

export async function flood(label: string) {
    try {
        await writeAndRead(`tmp/${label}/flood`, label, FLOOD);
        return "ok";
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

async function writeAndRead(dir: string, label: string, count: number) {
    await fs.promises.mkdir(dir, { recursive: true });
    const files = Array.from({ length: count }, (_, i) => i);
    await Promise.all(
        files.map((i) =>
            fs.promises.writeFile(`${dir}/${i}.txt`, `${label} ${i}`)
        )
    );
    const contents = await Promise.all(
        files.map((i) => fs.promises.readFile(`${dir}/${i}.txt`, "utf8"))
    );
    contents.forEach((content, i) =>
        expect(`${i}.txt`, content, `${label} ${i}`)
    );
}
