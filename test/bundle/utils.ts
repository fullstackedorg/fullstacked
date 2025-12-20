import fs from "node:fs";
import path from "node:path";
import { Page } from "puppeteer";

export function cleanupBundledFiles(directory: string) {
    fs.readdirSync(directory, { recursive: true })
        .filter((f: string) => f.split("/").pop().startsWith("_"))
        .forEach((f: string) => fs.rmSync(path.join(directory, f)));
}

export async function getPixelColorRGB(
    page: Page,
    pos: { x: number; y: number }
) {
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
