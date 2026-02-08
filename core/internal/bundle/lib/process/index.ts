//@ts-ignore
import p from "./index.js";
import path from "path";

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
function hrtime(previousTimestamp) {
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

p.hrtime = hrtime;
let currentDir = "/";
p.chdir = (dir: string) => {
    if (dir.startsWith("/")) {
        currentDir = dir;
    } else {
        currentDir = path.resolve(currentDir, dir);
    }
};
p.cwd = () => currentDir;

globalThis.process = p;
export * from "./index.js";
