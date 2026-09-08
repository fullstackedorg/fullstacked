import { getConfig, setConfig } from "../config/index.ts";

let isAutoResizeDisabled = false;

export function disableAutoWindowSize() {
    isAutoResizeDisabled = true;
}

async function loadSavedSize() {
    try {
        const savedData = await getConfig("windowSize");
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
    } catch {}

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
            const sizeStr = await globalThis.fullstacked.window.getSize();
            if (
                sizeStr &&
                (sizeStr.includes(":") ||
                    sizeStr === "fullscreen" ||
                    sizeStr === "kiosk")
            ) {
                await setConfig("windowSize", sizeStr.trim());
            }
        } catch {}
    }, 200);
}

export async function setup() {
    if (!globalThis.fullstacked.window.resize) {
        return;
    }

    let defaultSize = process.env.WINDOW_SIZE;

    if (typeof globalThis.addEventListener === "function") {
        globalThis.addEventListener("resize", onResize);
    }

    if (isAutoResizeDisabled) {
        return;
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
        globalThis.fullstacked.window.resize?.(defaultSize);
    }
}

const parentWindow = {
    disableAutoWindowSize,
    setup
};

export default parentWindow;
