import { Core } from "../@types/index.ts";
import { Exit, GetEnv } from "../@types/router.ts";
import { bridge } from "../bridge/index.ts";
import { isWorker } from "../bridge/isWorker.ts";
import { chdir } from "./cwd/chdir.ts";
import { cwd } from "./cwd/index.ts";
import process from "./process.js";
export * from "./process.js";
import fullstacked from "./version.json";
import { readFile, writeFile, mkdir } from "../fs/promises.ts";

if (globalThis.process === undefined) {
    globalThis.process = process;
}

// polyfil for window.performance.now
var performance = globalThis.performance || {};

var performanceNow =
    //@ts-ignore
    performance.now ||
    //@ts-ignore
    performance.mozNow ||
    //@ts-ignore
    performance.msNow ||
    //@ts-ignore
    performance.oNow ||
    //@ts-ignore
    performance.webkitNow ||
    function () {
        return new Date().getTime();
    };

// generate timestamp or delta
// see http://nodejs.org/api/process.html#process_process_hrtime
export function hrtime(previousTimestamp) {
    var clocktime = performanceNow.call(performance) * 1e-3;
    var seconds = Math.floor(clocktime);
    var nanoseconds = Math.floor((clocktime % 1) * 1e9);
    if (previousTimestamp) {
        seconds = seconds - previousTimestamp[0];
        nanoseconds = nanoseconds - previousTimestamp[1];
        if (nanoseconds < 0) {
            seconds--;
            nanoseconds += 1e9;
        }
    }
    return [seconds, nanoseconds];
}

export function exit() {
    if (isWorker) {
        self.postMessage("exit", {
            targetOrigin: "process"
        });
        self.close();
    }
}

process.hrtime = hrtime;
process.cwd = cwd;
process.chdir = chdir;
process.versions = { node: "", fullstacked };
process.exit = exit;
process.stdout = {
    isTTY: false
};
process.stderr = {
    isTTY: false
};
const envData = bridge(
    {
        mod: Core,
        fn: GetEnv
    },
    true
);
process.env = {
    ...process.env,
    ...(envData || {})
};

if (typeof globalThis.resize === "function") {
    let defaultSize = process.env.WINDOW_SIZE;
    let isAutoResizeDisabled =
        (globalThis as any).disableAutoWindowSize === true;

    const loadSavedSize = async (): Promise<string | null> => {
        if (isAutoResizeDisabled) {
            return null;
        }
        try {
            const savedData = await readFile("/.git/window-size.txt", {
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
        } catch (e) {
            // Ignore error
        }
        return null;
    };

    let saveTimeout: any = null;
    const onResize = () => {
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
                        await mkdir("/.git");
                    } catch (e) {
                        // Ignore folder already exists error
                    }
                    await writeFile("/.git/window-size.txt", sizeStr.trim());
                }
            } catch (e) {
                // Ignore
            }
        }, 200);
    };

    globalThis.addEventListener("resize", onResize);

    (globalThis as any).disableAutoWindowSize = () => {
        isAutoResizeDisabled = true;
        globalThis.removeEventListener("resize", onResize);
    };

    (async () => {
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
            globalThis.resize(defaultSize);
        }
    })();
}

process.exit = function () {
    if (typeof globalThis.exit !== "function") {
        return false;
    }

    bridge(
        {
            mod: Core,
            fn: Exit,
            data: []
        },
        true
    );

    globalThis.exit();

    return true;
};

export default process;
