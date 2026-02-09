//@ts-ignore
import p from "./process.js";
import path from "path";

export const isWorker =
    typeof globalThis.WorkerGlobalScope !== "undefined" &&
    self instanceof globalThis.WorkerGlobalScope;

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

let currentDir = "/";
export function cwd() {
    return currentDir;
}
export function chdir(dir: string) {
    if (dir.startsWith("/")) {
        currentDir = dir;
    } else {
        currentDir = path.resolve(currentDir, dir);
    }
}
export const versions = {
    node: "0.0.0"
};
export function exit() {
    if (isWorker) {
        self.postMessage("exit");
        self.close();
    }
}

p.hrtime = hrtime;
p.cwd = cwd;
p.chdir = chdir;
p.versions = versions;
p.exit = exit;

if (globalThis.process === undefined) {
    globalThis.process = p;
}
export * from "./index.js";
