import git from "./git";
import { SnackBar } from "./components/snackbar";
import packages from "./packages";
import build from "./build";
import debug from "./debug";

let lastUpdateCheck = 0;
const updateCheckDelay = 1000 * 10; // 10sec;
let checking = false;
let disabled = false;

export function disableAutoUpdate() {
    disabled = true;
}
export function enableAutoUpdate() {
    disabled = false;
}

function checkForUpdates() {
    window.requestAnimationFrame(checkForUpdates);

    const now = Date.now();
    if (disabled || now - lastUpdateCheck < updateCheckDelay || checking) {
        return;
    }

    checking = true;

    git.pull().then(async (pullResponse) => {
        if (pullResponse === git.PullResponse.DID_PULL) {
            let preventReload = false;
            const preventReloadButton = document.createElement("button");
            preventReloadButton.innerText = "Stop";
            preventReloadButton.onclick = () => {
                preventReload = true;
                snackbar.dismiss();
            };

            const snackbar = SnackBar({
                message: "Project has updated. Rebuilding...",
                button: preventReloadButton
            });

            await update();
            snackbar.dismiss();

            if (!preventReload) {
                window.location.reload();
                return;
            }
        }

        checking = false;
        lastUpdateCheck = now;
    });
}
if (await git.hasGit()) {
    checkForUpdates();
}

async function update() {
    await packages.installQuick();
    return build.buildProject();
}
