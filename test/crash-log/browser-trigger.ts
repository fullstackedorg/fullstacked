import "../../core/internal/bundle/lib/fullstacked/index.ts";
import core from "../core.ts";
import { createBrowser } from "../browser.ts";
import * as fs from "../../core/internal/bundle/lib/fs/index.ts";

const message = process.argv[2];

if (!message) {
    console.error("Missing arguments");
    process.exit(1);
}

// 1. Start core (loads core and registers standard callback listeners)
await core.start();

// Append to the crash log from JS context before browser crash panic
await fs.promises.appendFile("crash.log", `JS_LOG_PREFIX: ${message}\n`);

// 2. Start browser webview using sample directory
const browser = await createBrowser("sample");

// 3. Create a browser page
const pageObj = await browser.createPage(null);
const page = pageObj.page;

page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
page.on("pageerror", (err) => console.error("BROWSER ERROR:", err));

// 4. Navigate to the webview port and pass the query param
await page.goto(
    `http://localhost:${browser.webview.port}/?message=${encodeURIComponent(message)}`
);

// 5. Set a timeout to exit if it hasn't crashed
setTimeout(() => {
    console.error("Test did not crash the process within 5 seconds");
    process.exit(1);
}, 5000);
