import git from "./git";
import { Button } from "@fullstacked/ui";
import { SnackBar } from "./components/snackbar";
import packages from "./packages";
import build from "./build";

let lastUpdateCheck = 0;
const updateCheckDelay = 1000 * 10; // 10sec;
let updating = false;
let disabled = false;

export function disableAutoUpdate() {
    disabled = true;
}
export function enableAutoUpdate() {
    disabled = false;
}

async function checkForUpdates() {
    window.requestAnimationFrame(checkForUpdates);

    const now = Date.now();
    if (disabled || now - lastUpdateCheck < updateCheckDelay || updating) {
        return;
    }

    lastUpdateCheck = now;

    const pullResponse = await git.pull();
    if (pullResponse !== git.PullResponse.DID_PULL) {
        return;
    }

    let preventReload = false;
    const preventReloadButton = Button({
        text: "Stop"
    });
    preventReloadButton.onclick = () => {
        preventReload = true;
        snackbar.dismiss();
    };

    const snackbar = SnackBar({
        message: "Project has updated. Rebuilding...",
        button: preventReloadButton
    });

    updating = true;
    update().then(() => {
        updating = false;
        snackbar.dismiss();

        if (preventReload) return;
        window.location.reload();
    });
}
if (await git.hasGit()) {
    checkForUpdates();
}

async function update() {
    await packages.installQuick();
    return build.buildProject();
}
