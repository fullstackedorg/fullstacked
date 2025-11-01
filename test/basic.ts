import child_process from "node:child_process";
import path from "node:path";
import os from "node:os";
import puppeteer, { ElementHandle, KeyInput } from "puppeteer";
import {
    IMPORT_PROJECT_FILE_INPUT_ID,
    IMPORT_ZIP_ID,
    NEW_FILE_ID,
    NEW_PROJECT_ID,
    PROJECTS_TITLE,
    PROJECTS_VIEW_ID,
    RUN_PROJECT_ID
} from "../editor/constants";
import {
    createBrowser,
    sleep,
    throwError,
    waitForStackNavigation
} from "./utils";

// test build
child_process.execSync("npm run build", {
    stdio: "inherit"
});

// test node build
child_process.execSync("npm run build", {
    cwd: "platform/node",
    stdio: "inherit"
});

// test functionalities with node
process.chdir(process.cwd() + "/platform/node");
process.env.NO_OPEN = "1";
process.env.FULLSTACKED_LIB = path.resolve(
    process.cwd(),
    "..",
    "..",
    "core",
    "bin"
);
process.env.FULLSTACKED_ROOT = path.resolve(os.homedir(), "FullStacked");
process.env.FULLSTACKED_CONFIG = path.resolve(
    os.homedir(),
    ".config",
    "fullstacked"
);
process.env.FULLSTACKED_EDITOR = path.resolve(
    process.cwd(),
    "..",
    "..",
    "out",
    "build"
);

await import(process.cwd().replace(/\\/g, "/").split(":").pop() + "/index.js");

// Launch the browser
const { browser, createPage } = await createBrowser();
const page = await createPage();
await page.goto("http://localhost:9000");

// Check the Projects Title
await page.waitForSelector("h1");
const getHeadingText = () => document.querySelector("h1")?.textContent;
const projectsTitle = await page.evaluate(getHeadingText);
if (projectsTitle !== PROJECTS_TITLE) {
    const errorMsg = `Projects title does not match. Expected [${PROJECTS_TITLE}] Found [${projectsTitle}]`;
    throwError(errorMsg);
}

// import demo project
await waitForStackNavigation(page, `#${NEW_PROJECT_ID}`);
await waitForStackNavigation(page, `#${IMPORT_ZIP_ID}`);

await sleep(500);

const importProjectFileInput = (await page.waitForSelector(
    `#${IMPORT_PROJECT_FILE_INPUT_ID}`
)) as ElementHandle<HTMLInputElement>;
await importProjectFileInput.uploadFile("../../out/build/demo.zip");

await sleep(2000);

await waitForStackNavigation(
    page,
    `#${PROJECTS_VIEW_ID} .project-tile:first-child`
);

await sleep(3000);

// add file
const newFileButton = await page.waitForSelector(`#${NEW_FILE_ID}`);
await newFileButton.click();
await page.waitForSelector("input");
const testFileName = "test.txt";
for (let i = 0; i < testFileName.length; i++) {
    await sleep(100);
    await page.keyboard.press(testFileName[i] as KeyInput);
}
await page.keyboard.press("Enter");
let tries = 10;
while (tries) {
    tries--;
    const getFileTreeItemsTitle = () =>
        Array.from(
            document.querySelectorAll(".file-item > div:nth-child(2)") ?? []
        ).map((e) => e.textContent.trim());
    const fileTreeItems = await page.evaluate(getFileTreeItemsTitle);

    if (!fileTreeItems.includes(testFileName)) {
        if (!tries) {
            const errorMsg = `Could not found file in file tree. Searching [${testFileName}] in [${fileTreeItems.join(", ")}] `;
            throwError(errorMsg);
        } else {
            await sleep(200);
        }
    } else {
        break;
    }
}

const runProjectButton = await page.waitForSelector(`#${RUN_PROJECT_ID}`);
await runProjectButton.click();

const getDialogHeadingText = () =>
    document.querySelector(".dialog h3")?.textContent;

// wait for dependencies to load
let caughtDependencies = false;
tries = 20;
while (tries) {
    tries--;

    const dependenciesDialogTitle = await page.evaluate(getDialogHeadingText);
    if (dependenciesDialogTitle === "Dependencies") {
        caughtDependencies = true;
    } else {
        await sleep(100);
    }

    if (caughtDependencies) {
        break;
    } else if (tries === 0) {
        throwError("Never caught installing dependencies");
    }
}
tries = 5;
while (tries) {
    tries--;
    const dependenciesDialogTitle = await page.evaluate(getDialogHeadingText);
    if (dependenciesDialogTitle === "Dependencies") {
        await sleep(3000); // max 15sec to load react
    } else {
        break;
    }
}

const back = await page.waitForSelector(".back-button");
await back.click();

await sleep(2000);

// try to go to launched demo
tries = 3;
while (tries) {
    tries--;
    try {
        await page.goto("http://localhost:9001");
    } catch (e) {
        if (!tries) throwError(e);

        const dependenciesDialogTitle = await page.evaluate(getHeadingText);
        console.log(dependenciesDialogTitle);
        if (dependenciesDialogTitle === "Dependencies") {
            await sleep(5000);
        } else {
            await sleep(100);
        }
    }
}

const demoHeadingText = await page.evaluate(getHeadingText);
const expected = "Welcome to FullStacked";
if (demoHeadingText !== expected) {
    const errorMsg = `Projects title does not match. Expected [${expected}] Found [${demoHeadingText}]`;
    throwError(errorMsg);
}

process.exit(0);
