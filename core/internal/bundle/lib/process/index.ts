import { Core } from "../@types/index.ts";
import { Chdir, Cwd, Exit, GetEnv } from "../@types/router.ts";
import { bridge } from "../bridge/index.ts";
import { isWorker } from "../bridge/isWorker.ts";
import fullstacked from "./version.json" with { type: "json" };
import { setTimeout, clearTimeout } from "../timers/index.ts";
import { readFile, writeFile, mkdir } from "../fs/promises.ts";

// Shims from process.browser.js
class Item {
    constructor(
        public fun: Function,
        public array: any[]
    ) {}
    run() {
        this.fun.apply(null, this.array);
    }
}

let queue: Item[] = [];
let draining = false;
let currentQueue: Item[] | null = null;
let queueIndex = -1;

function runTimeout(fun: Function) {
    return setTimeout(fun as any, 0);
}

function runClearTimeout(marker: any) {
    return clearTimeout(marker);
}

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    const timeout = runTimeout(cleanUpNextTick);
    draining = true;
    let len = queue.length;
    while (len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

// Polyfill for window.performance.now
const performance = globalThis.performance || {};
const performanceNow =
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

// Local variables / functions
export const noop = () => {};
export const title = "browser";
export const browser = true;
export const argv: string[] = [];
export const version = "";
export const versions = {
    fullstacked
};
export const env = new Proxy(
    {},
    {
        get(target, prop) {
            return (process.env as any)[prop];
        },
        set(target, prop, val) {
            (process.env as any)[prop] = val;
            return true;
        },
        ownKeys() {
            return Reflect.ownKeys(process.env);
        },
        getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(process.env, prop);
        }
    }
) as Record<string, string>;

export function hrtime(previousTimestamp?: [number, number]) {
    const clocktime = performanceNow.call(performance) * 1e-3;
    let seconds = Math.floor(clocktime);
    let nanoseconds = Math.floor((clocktime % 1) * 1e9);
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
        return true;
    }

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
}

export function nextTick(fun: Function, ...args: any[]) {
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
}

export function listeners(name: string) {
    return [];
}

export function binding(name: string) {
    throw new Error("process.binding is not supported");
}

export function cwd() {
    return bridge(
        {
            mod: Core,
            fn: Cwd,
            data: []
        },
        true
    ) as string;
}

export function chdir(dir: string) {
    return bridge(
        {
            mod: Core,
            fn: Chdir,
            data: [dir]
        },
        true
    );
}

export function umask() {
    return 0;
}

export const stdout = {
    isTTY: false
};
export const stderr = {
    isTTY: false
};

export const on = noop;
export const addListener = noop;
export const once = noop;
export const off = noop;
export const removeListener = noop;
export const removeAllListeners = noop;
export const emit = noop;
export const prependListener = noop;
export const prependOnceListener = noop;

// Build the process object
export const process = {
    title,
    browser,
    get env() {
        return (
            bridge(
                {
                    mod: Core,
                    fn: GetEnv
                },
                true
            ) || {}
        );
    },
    argv,
    version,
    versions,
    nextTick,
    on,
    addListener,
    once,
    off,
    removeListener,
    removeAllListeners,
    emit,
    prependListener,
    prependOnceListener,
    listeners,
    binding,
    cwd,
    chdir,
    umask,
    hrtime,
    exit,
    stdout,
    stderr
};

if (globalThis.process === undefined) {
    globalThis.process = process as any;
}

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

export default process;
