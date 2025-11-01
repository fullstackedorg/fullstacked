import child_process from "node:child_process";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import assert from "node:assert";
import { createBrowser, sleep, throwError } from "./utils";
import puppeteer, { KeyInput, Page } from "puppeteer";
import {
    NEW_FILE_ID,
    PROJECT_VIEW_ID,
    RUN_PROJECT_ID
} from "../editor/constants";

const cacheDirectory = path.resolve("test", ".cache");

const testId = crypto.randomUUID().split("-").at(0);

const testDirectory = path.resolve(cacheDirectory, testId);

const localGitServerDir = path.resolve("test", "local-git-server");
const gitHost = "http://localhost:8080";
const repoName = "test-repo";

const dockerLocalGitServerCommands = [
    "docker compose down -t 0",
    "docker compose build",
    "docker compose up -d",
    `docker compose exec git-server mkrepo ${repoName}`
];

for (const cmd of dockerLocalGitServerCommands) {
    child_process.execSync(cmd, {
        cwd: localGitServerDir,
        stdio: "inherit"
    });
}

let editorProcess: child_process.ChildProcess,
    editorProcess2: child_process.ChildProcess,
    kioskProcess: child_process.ChildProcess;

const cleanup = () => {
    child_process.execSync(dockerLocalGitServerCommands.at(0), {
        cwd: localGitServerDir,
        stdio: "inherit"
    });
    editorProcess?.stdin?.end();
    editorProcess?.kill();
    editorProcess2?.stdin?.end();
    editorProcess2?.kill();
    kioskProcess?.kill();
};

const onError = (e) => {
    console.log(e);
    cleanup();
    throwError("git commit/auto-update test failed");
};

process.on("uncaughtException", onError);
process.on("unhandledRejection", onError);

const repo = `${gitHost}/${repoName}`;

editorProcess = child_process.exec(`node index.js ${repo}`, {
    cwd: process.cwd() + "/platform/node",
    env: {
        ...process.env,
        NO_OPEN: "1",
        FULLSTACKED_LIB: path.resolve(process.cwd(), "core", "bin"),
        FULLSTACKED_ROOT: path.resolve(testDirectory, "root"),
        FULLSTACKED_CONFIG: path.resolve(testDirectory, "config"),
        FULLSTACKED_EDITOR: path.resolve(process.cwd(), "out", "build")
    }
});
editorProcess.stdout.pipe(process.stdout);
editorProcess.stderr.pipe(process.stderr);

await sleep(3000);

const { browser, createPage } = await createBrowser();
const editorPage = await createPage();
await editorPage.goto("http://localhost:9000");
await editorPage.waitForSelector(`#${RUN_PROJECT_ID}`);
await editorPage.waitForSelector(`#${PROJECT_VIEW_ID} h1`);

async function writeFileContent(file: string, content: string) {
    await editorPage.evaluate((file) => {
        document
            .querySelectorAll<HTMLDivElement>(".file-item")
            .forEach((el) => {
                if (
                    el.querySelector(":scope > div:nth-child(2)").innerHTML ===
                    file
                ) {
                    el.click();
                }
            });
    }, file);

    await sleep(1000);

    const codeEditor = await editorPage.waitForSelector(".cm-activeLine");
    await codeEditor.click({
        count: 3
    });

    for (let i = 0; i < content.length; i++) {
        await sleep(10);
        await editorPage.keyboard.press(content[i] as KeyInput);
        const stop = await editorPage.evaluate((content) => {
            const actualContent =
                document.querySelector<HTMLDivElement>(".cm-content").innerText;
            return (
                content.replace(/\s/g, "") === actualContent.replace(/\s/g, "")
            );
        }, content);
        if (stop) {
            break;
        }
    }
}

await sleep(1000);

const sampleProjectDir = path.resolve("test", "sample-project");
const sampleProjectItems = fs.readdirSync(sampleProjectDir);
for (const sampleProjectItem of sampleProjectItems) {
    const newFileButton = await editorPage.waitForSelector(`#${NEW_FILE_ID}`);
    await newFileButton.click();
    await editorPage.waitForSelector("input");
    for (let i = 0; i < sampleProjectItem.length; i++) {
        await sleep(100);
        await editorPage.keyboard.press(sampleProjectItem[i] as KeyInput);
    }
    await editorPage.keyboard.press("Enter");

    await sleep(1000);
    await writeFileContent(
        sampleProjectItem,
        fs.readFileSync(path.resolve(sampleProjectDir, sampleProjectItem), {
            encoding: "utf-8"
        })
    );
}

const runProjectButton = await editorPage.waitForSelector(`#${RUN_PROJECT_ID}`);
await runProjectButton.click();

await sleep(2000);

const appPage = await createPage();
await appPage.goto("http://localhost:9001");

await sleep(2000);

async function getTitleAndColor(page: Page) {
    const pngBase64 = await page.screenshot({
        encoding: "base64"
    });
    return page.evaluate(
        (b64) =>
            new Promise<{
                currentTitle: string;
                currentColor: [number, number, number];
            }>((res) => {
                const image = new Image();
                image.onload = function () {
                    const canvas = document.createElement("canvas");
                    canvas.width = image.width;
                    canvas.height = image.height;

                    const context = canvas.getContext("2d");
                    context.drawImage(image, 0, 0);

                    const imageData = context.getImageData(
                        0,
                        0,
                        canvas.width,
                        canvas.height
                    );

                    const index = imageData.width * 4;
                    const red = imageData.data[index];
                    const green = imageData.data[index + 1];
                    const blue = imageData.data[index + 2];
                    res({
                        currentTitle: document.querySelector("h1").innerText,
                        currentColor: [red, green, blue]
                    });
                };
                image.src = "data:image/png;base64," + b64;
            }),
        pngBase64
    );
}

assert.deepEqual(await getTitleAndColor(appPage), {
    currentTitle: "Hello World",
    currentColor: [255, 0, 0]
});

await editorPage.bringToFront();

const gitWidget = await editorPage.waitForSelector(".git-widget > button");
await gitWidget.click();

await sleep(1000);

const authorButton = await editorPage.waitForSelector(
    ".git-author-infos button"
);
await authorButton.click();

await sleep(1000);

const authorNameInput = await editorPage.waitForSelector(
    ".git-author-form > div:first-child input"
);
await authorNameInput.click();

for (let i = 0; i < testId.length; i++) {
    await sleep(100);
    await editorPage.keyboard.press(testId[i] as KeyInput);
}

await editorPage.keyboard.press("Enter");

await sleep(1000);

const commitInput = await editorPage.waitForSelector(".git-form input");
await commitInput.click();

for (let i = 0; i < testId.length; i++) {
    await sleep(100);
    await editorPage.keyboard.press(testId[i] as KeyInput);
}

await sleep(1000);

const pushButton = await editorPage.waitForSelector(
    ".git-buttons > div > button:last-child"
);
await pushButton.click();

const testId2 = crypto.randomUUID().split("-").at(0);

const testDirectory2 = path.resolve(cacheDirectory, testId2);

editorProcess2 = child_process.exec(`node index.js ${repo}`, {
    cwd: process.cwd() + "/platform/node",
    env: {
        ...process.env,
        NO_OPEN: "1",
        FULLSTACKED_LIB: path.resolve(process.cwd(), "core", "bin"),
        FULLSTACKED_ROOT: path.resolve(testDirectory2, "root"),
        FULLSTACKED_CONFIG: path.resolve(testDirectory2, "config"),
        FULLSTACKED_EDITOR: path.resolve(process.cwd(), "out", "build")
    }
});
editorProcess2.stdout.pipe(process.stdout);
editorProcess2.stderr.pipe(process.stderr);

await sleep(3000);

const editorPage2 = await createPage();
await editorPage2.goto("http://localhost:9002");
await editorPage2.waitForSelector(`#${RUN_PROJECT_ID}`);
const projectTitle = await (
    await editorPage2.waitForSelector(`#${PROJECT_VIEW_ID} h1`)
).getProperty("textContent");

assert.equal(await projectTitle.jsonValue(), repoName);

await sleep(1000);

const editorPage2Back = await editorPage2.waitForSelector(".back-button");
await editorPage2Back.click();

await sleep(2000);

await editorPage2.close();

kioskProcess = child_process.exec(`node index.js --kiosk ${repoName}`, {
    cwd: process.cwd() + "/platform/node",
    env: {
        ...process.env,
        NO_OPEN: "1",
        FULLSTACKED_LIB: path.resolve(process.cwd(), "core", "bin"),
        FULLSTACKED_ROOT: path.resolve(testDirectory2, "root"),
        FULLSTACKED_CONFIG: path.resolve(testDirectory2, "config"),
        FULLSTACKED_EDITOR: path.resolve(process.cwd(), "out", "build")
    }
});
kioskProcess.stdout.pipe(process.stdout);
kioskProcess.stderr.pipe(process.stderr);

await sleep(3000);

const kioskPage = await createPage();
await kioskPage.goto("http://localhost:9003");

assert.deepEqual(await getTitleAndColor(kioskPage), {
    currentTitle: "Hello World",
    currentColor: [255, 0, 0]
});

await editorPage.bringToFront();

await writeFileContent("text.txt", testId);
await writeFileContent("c.scss", `$color: #00FF00`);

await runProjectButton.click();

await sleep(2000);

await appPage.bringToFront();
await appPage.reload();

await sleep(2000);

assert.deepEqual(await getTitleAndColor(appPage), {
    currentTitle: testId,
    currentColor: [0, 255, 0]
});

await editorPage.bringToFront();

const gitWidget2 = await editorPage.waitForSelector(".git-widget > button");
await gitWidget2.click();

await sleep(1000);

const commitInput2 = await editorPage.waitForSelector(".git-form input");
await commitInput2.click();

for (let i = 0; i < testId.length; i++) {
    await sleep(100);
    await editorPage.keyboard.press(testId[i] as KeyInput);
}

await editorPage.keyboard.press("Enter");

await sleep(1000);

await kioskPage.bringToFront();

await sleep(1000 * 20);

assert.deepEqual(await getTitleAndColor(kioskPage), {
    currentTitle: testId,
    currentColor: [0, 255, 0]
});

await editorPage.bringToFront();

const editorPageBack = await editorPage.waitForSelector(".back-button");
await editorPageBack.click();

await sleep(2000);

cleanup();
process.exit(0);
