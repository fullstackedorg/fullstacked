import fs from "../fs/index.ts";

let isAutoResizeDisabled = false;

export function disableAutoWindowSize() {
    isAutoResizeDisabled = true;
}

async function loadSavedSize() {
    try {
        const savedData = await fs.promises.readFile("/.git/window-size.txt", {
            encoding: "utf-8"
        });
        if (savedData) {
            const savedSize = savedData.trim();
            if (
                savedSize &&
                (savedSize.includes(":") ||
                    savedSize === "fullscreen" ||
                    savedSize === "kiosk")
            ) {
                return savedSize;
            }
        }
    } catch { }

    return null;
}


let saveTimeout: any = null;

function onResize() {
    if (isAutoResizeDisabled) {
        return;
    }

    clearTimeout(saveTimeout);

    saveTimeout = setTimeout(async () => {
        try {
            const sizeStr = await (globalThis as any).resize("get");
            if (
                sizeStr &&
                (sizeStr.includes(":") ||
                    sizeStr === "fullscreen" ||
                    sizeStr === "kiosk")
            ) {
                try {
                    await fs.promises.mkdir("/.git");
                } catch { }
                await fs.promises.writeFile("/.git/window-size.txt", sizeStr.trim());
            }
        } catch { }
    }, 200);
}

export async function setup() {
    if (!globalThis.fullstacked.window.resize) { return; }

    let defaultSize = process.env.WINDOW_SIZE;

    globalThis.addEventListener("resize", onResize);

    if (isAutoResizeDisabled) {
        return
    }

    let savedSize = await loadSavedSize();

    if (savedSize) {
        if (savedSize === "kiosk") {
            savedSize = "fullscreen";
        }
        if (!defaultSize) {
            defaultSize = savedSize;
        }
    }

    if (defaultSize) {
        globalThis.fullstacked.window.resize?.(defaultSize)
    }
}

const parentWindow = {
    disableAutoWindowSize,
    setup
}

export default parentWindow;