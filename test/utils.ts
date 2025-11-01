import puppeteer, { Page } from "puppeteer";

export const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

export const throwError = (message: string) => {
    const error = Error(message);
    console.error(error);
    process.exit(1);
};

export const waitForStackNavigation = (page: Page, selector: string) => {
    return new Promise<void>(async (resolve, reject) => {
        let clicked = false;
        while (!clicked) {
            try {
                const element = await page.waitForSelector(selector);
                await element.click();
                clicked = true;
            } catch (e) {
                await sleep(100);
            }

            if (clicked) {
                break;
            }
        }
        await sleep(500);
        resolve();
    });
};

export async function createBrowser() {
    const browser = await puppeteer.launch({
        headless: false
    });

    return {
        browser,
        async createPage() {
            const page = await browser.newPage();
            page.on("console", (message) =>
                console.log(
                    `[${page.url()}] ${message.type()} ${message.text()}`
                )
            )
                .on("pageerror", ({ message }) =>
                    console.log(`[${page.url()}] ERROR ${message}`)
                )
                .on("requestfailed", (request) =>
                    console.log(
                        `[${page.url()}] ${request.failure().errorText} ${request.url()}`
                    )
                );
            return page;
        }
    };
}
