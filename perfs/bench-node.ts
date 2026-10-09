// Runs the shell `bench` command on the Node host in headless Chrome
// (puppeteer), for CI or a quick local run:
//
//   npm run build && npm run build -w platform/node
//   node perfs/bench-node.ts [-o node.json] [--no-build] [--show-browser] [-- <bench args>]
//
// The shell is bundled first (--no-build skips it), the results are written
// to -o (default node.json in the current directory). Bench args default to
// the ones of perfs/plan.md.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

process.env.TEST = "1"; // the Node host does not open a browser

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const benchArgs =
    separator === -1
        ? "-n 200 -s 1k,64k -t 4m -k 4k,256k -r 2"
        : args.slice(separator + 1).join(" ");
const ownArgs = separator === -1 ? args : args.slice(0, separator);
const outputIndex = ownArgs.findIndex((a) => a === "-o" || a === "--output");
const output = path.resolve(
    outputIndex === -1 ? "node.json" : ownArgs[outputIndex + 1]
);
const timeoutMs = 15 * 60 * 1000;

// written by the shell in its own directory, moved to output after
const shellOutput = ".bench-node.json";
const shellOutputPath = path.join("shell", shellOutput);
fs.rmSync(shellOutputPath, { force: true });

const { createWebView, stop } = await import("../platform/node/src/index.ts");
const { bundle } = await import("../core/internal/bundle/lib/bundle/index.ts");
const { run } = await import("../core/internal/bundle/lib/run/index.ts");

if (!ownArgs.includes("--no-build")) {
    console.log("Bundling the shell...");
    const result = await bundle("shell");
    if (result.Errors?.length) {
        console.error(result.Errors);
        process.exit(1);
    }
}

const ctx = await run({ directory: "shell" });
const webview = await createWebView(ctx, { quiet: true });

const showBrowser = ownArgs.includes("--show-browser");
const browser = await puppeteer.launch({ headless: !showBrowser });
const page = await browser.newPage();
page.on("pageerror", (error) => console.error("[page]", error));
page.on("console", (message) => {
    if (message.type() === "error") console.error("[page]", message.text());
});

let exitCode = 0;
try {
    await page.goto(`http://localhost:${webview.port}`);
    const input = await page.waitForSelector(".xterm-helper-textarea");
    // the prompt is ready once the shell wrote it
    await page.waitForFunction(
        () => document.querySelector(".xterm-rows")?.textContent?.includes("$"),
        { timeout: 30000 }
    );
    await input.focus();
    const command = `bench ${benchArgs} -o ${shellOutput}`;
    console.log(`Running: ${command}`);
    await page.keyboard.type(command);
    // not awaited: the sync suites block the page, its key up would time out
    page.keyboard.press("Enter").catch(() => {});

    const start = Date.now();
    while (!fs.existsSync(shellOutputPath)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`bench did not finish in ${timeoutMs / 1000}s`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // written once, give it time to land entirely
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.renameSync(shellOutputPath, output);
    console.log(`Results written to ${output}`);
} catch (e) {
    console.error(e);
    exitCode = 1;
} finally {
    await browser.close();
    webview.close();
    stop();
    process.exit(exitCode);
}
