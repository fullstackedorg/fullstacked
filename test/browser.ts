import puppeteer from "puppeteer";

export async function createBrowser() {
    const browser = await puppeteer.launch({
        headless: !process.argv.includes("--show-browser")
    });

    return {
        browser,
        async createPage() {
            const page = await browser.newPage();
            // page.on("console", (message) =>
            //     console.log(
            //         `[${page.url()}] ${message.type()} ${message.text()}`
            //     )
            // )
            //     .on("pageerror", ({ message }) =>
            //         console.log(`[${page.url()}] ERROR ${message}`)
            //     )
            //     .on("requestfailed", (request) =>
            //         console.log(
            //             `[${page.url()}] ${request.failure().errorText} ${request.url()}`
            //         )
            //     );
            return {
                page,
                async getTextContent(selector: string) {
                    const handle = await page.waitForSelector(selector);
                    const jsHandle = await handle.getProperty("textContent");
                    return jsHandle.jsonValue();
                }
            };
        }
    };
}
