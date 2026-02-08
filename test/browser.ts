import puppeteer from "puppeteer";
import { createWebView } from "../platform/node/src/webview.ts";
import core from "./core.ts";

export type Browser = Awaited<ReturnType<typeof createBrowser>>;

export async function createBrowser(directory: string) {
    const ctx = core.instance.start(directory);
    const webview = await createWebView(core.instance, ctx);
    core.callbackListeners.add(webview.callback);

    const browser = await puppeteer.launch({
        headless: !process.argv.includes("--show-browser"),
        devtools: process.argv.includes("--show-browser")
    });

    const createPage = async (url?: string) => {
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
        if (url !== null) {
            await page.goto(url || `http://localhost:${webview.port}`);
        }
        return {
            page,
            async getTextContent(selector: string) {
                const handle = await page.waitForSelector(selector);
                const jsHandle = await handle.getProperty("textContent");
                return jsHandle.jsonValue();
            },
            async getPixelColorRGB(pos: { x: number; y: number }) {
                const pngBase64 = await page.screenshot({
                    encoding: "base64",
                    clip: {
                        ...pos,
                        height: 2,
                        width: 2
                    }
                });
                return page.evaluate(
                    (b64) =>
                        new Promise<[number, number, number]>((res) => {
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
                                res([red, green, blue]);
                            };
                            image.src = "data:image/png;base64," + b64;
                        }),
                    pngBase64
                );
            }
        };
    };

    return {
        browser,
        webview,
        sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
        end() {
            core.callbackListeners.delete(webview.callback);
            webview.close();
            return browser.close();
        },
        createPage
    };
}
