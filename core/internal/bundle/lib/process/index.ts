import { Core } from "../@types/index.ts";
import { Chdir, Cwd, Exit, GetEnv, Version } from "../@types/router.ts";
import { isWorker } from "../bridge/isWorker.ts";

// process.nextTick: a queue drained on one microtask, as close to Node's
// nextTick queue as a page allows (the queue runs in order, ticks queued
// while it drains run in the same drain, a throwing callback leaves the rest
// for the next microtask). It used to be a setTimeout(0): browsers clamp
// chained timers to 4 ms and throttle them in hidden pages, which made every
// npm package that defers with nextTick (browserify-zlib did) wait per chunk.
type Tick = { fn: Function; args: any[] };
let ticks: Tick[] = [];
let tickIndex = 0;
let tickScheduled = false;
// a resolved promise's reactions: on V8 a queueMicrotask costs about 8
// times as much
const resolved = Promise.resolve();

function drainTicks() {
    try {
        while (tickIndex < ticks.length) {
            const tick = ticks[tickIndex++];
            tick.fn.apply(null, tick.args);
        }
    } catch (error) {
        // reported as uncaught (a throw in a promise reaction would be an
        // unhandled rejection), then the rest runs on the next microtask
        queueMicrotask(() => {
            throw error;
        });
        if (tickIndex < ticks.length) {
            ticks = ticks.slice(tickIndex);
            tickIndex = 0;
            resolved.then(drainTicks);
            return;
        }
    }
    ticks = [];
    tickIndex = 0;
    tickScheduled = false;
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
const getQueryArgv = () => {
    try {
        const urlObj = new URL(import.meta.url);
        return urlObj.searchParams.getAll("argv");
    } catch {
        return [];
    }
};

export const argv: string[] = [];
const queryArgv = getQueryArgv();
if (queryArgv.length > 0) {
    argv.push(...queryArgv);
}
export const version = "";

// the version comes from the running core, not bundled in,
// so pre-bundled code reports the version it actually runs on
let fullstackedVersion: Record<string, string> = null;
function getFullStackedVersion() {
    if (!fullstackedVersion) {
        fullstackedVersion =
            globalThis.fullstacked.bridge(
                {
                    mod: Core,
                    fn: Version
                },
                true
            ) || {};
    }
    return fullstackedVersion;
}

export const versions = {
    fullstacked: new Proxy(
        {},
        {
            get(target, prop) {
                return (getFullStackedVersion() as any)[prop];
            },
            ownKeys() {
                return Reflect.ownKeys(getFullStackedVersion());
            },
            getOwnPropertyDescriptor(target, prop) {
                return Reflect.getOwnPropertyDescriptor(
                    getFullStackedVersion(),
                    prop
                );
            }
        }
    ) as Record<string, string>
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

    if (typeof globalThis.fullstacked.exit !== "function") {
        return false;
    }

    globalThis.fullstacked.bridge(
        {
            mod: Core,
            fn: Exit,
            data: []
        },
        true
    );

    globalThis.fullstacked.exit();
    return true;
}

export function nextTick(fn: Function, ...args: any[]) {
    ticks.push({ fn, args });
    if (!tickScheduled) {
        tickScheduled = true;
        resolved.then(drainTicks);
    }
}

export function listeners(name: string): Function[] {
    return [];
}

export function binding(name: string) {
    throw new Error("process.binding is not supported");
}

export function cwd() {
    return globalThis.fullstacked.bridge(
        {
            mod: Core,
            fn: Cwd,
            data: []
        },
        true
    ) as string;
}

export function chdir(dir: string) {
    return globalThis.fullstacked.bridge(
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

const defaultStdout = {
    isTTY: false,
    write(chunk: any, encoding?: any, cb?: any) {
        if (typeof encoding === "function") cb = encoding;
        if (typeof chunk === "string") console.log(chunk);
        if (cb) cb();
        return true;
    }
};

const defaultStderr = {
    isTTY: false,
    write(chunk: any, encoding?: any, cb?: any) {
        if (typeof encoding === "function") cb = encoding;
        if (typeof chunk === "string") console.error(chunk);
        if (cb) cb();
        return true;
    }
};

const defaultStdin = {
    isTTY: false,
    on: noop,
    addListener: noop,
    once: noop,
    off: noop,
    removeListener: noop,
    removeAllListeners: noop,
    emit: noop,
    pause: noop,
    resume: noop
};

const gProcess = (globalThis as any).process;
export const stdout = gProcess?.stdout || defaultStdout;
export const stderr = gProcess?.stderr || defaultStderr;
export const stdin = gProcess?.stdin || defaultStdin;

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
            globalThis.fullstacked.bridge(
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
    stdin,
    stdout,
    stderr
};

export default process;
