import os from "node:os";
import child_process from "child_process";

export function buildCore(noTSGO: boolean) {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === "win32") {
        child_process.execSync(
            `call ./windows.bat ${arch} ${noTSGO ? "NO_TSGO=1" : ""}`,
            {
                stdio: "inherit",
                cwd: "core/build"
            }
        );
    } else {
        const target_name = platform + "-" + arch + "-shared";
        child_process.execSync(
            `make ${target_name} ${noTSGO ? "NO_TSGO=1" : ""}`,
            {
                stdio: "inherit",
                cwd: "core/build"
            }
        );
    }
}
