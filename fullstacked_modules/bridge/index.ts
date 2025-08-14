import "../core_message";
import platform, { Platform } from "../platform";
import { BridgeAndroid } from "./platform/android";
import { BridgeApple, initRespondApple } from "./platform/apple";
import { BridgeLinuxGTK, initRespondLinuxGTK } from "./platform/linux-gtk";
import { BridgeLinuxQT, initRespondLinuxQT } from "./platform/linux-qt";
import { BridgeElectron } from "./platform/electron";
import { BridgeNode, initCallbackNode } from "./platform/node";
import { BridgeWasm } from "./platform/wasm";
import { BridgeWindows, initRespondWindows } from "./platform/windows";
import git from "../git";
import esbuild from "../esbuild";
import { SnackBar } from "../components/snackbar";
import { Button } from "@fullstacked/ui";
import { serializeArgs } from "./serialization";
import { buildSASS } from "../esbuild/sass";
import fs from "../fs";

export type Bridge = (
    payload: Uint8Array,
    transformer?: (args: any) => any
) => Promise<any>;

export let bridge: Bridge;
switch (platform) {
    case Platform.NODE:
        bridge = BridgeNode;
        initCallbackNode();
        break;
    case Platform.APPLE:
        bridge = BridgeApple;
        initRespondApple();
        break;
    case Platform.ANDROID:
        bridge = BridgeAndroid;
        break;
    case Platform.WASM:
        bridge = BridgeWasm;
        break;
    case Platform.WINDOWS:
        bridge = BridgeWindows;
        initRespondWindows();
        break;
    case Platform.LINUX_GTK:
        bridge = BridgeLinuxGTK;
        initRespondLinuxGTK();
        break;
    case Platform.LINUX_QT:
        bridge = BridgeLinuxQT;
        initRespondLinuxQT();
        break;
    case Platform.ELECTRON:
        bridge = BridgeElectron;
        break;
    case Platform.DOCKER:
        console.log("Bridge not yet implemented");
}

console.log("FullStacked");
bridge(new Uint8Array([0]));

let lastUpdateCheck = 0;
const updateCheckDelay = 1000 * 10 // 10sec;
async function checkForUpdates() {
    window.requestAnimationFrame(checkForUpdates)

    const now = Date.now();
    if (now - lastUpdateCheck < updateCheckDelay) {
        return;
    }

    lastUpdateCheck = now;

    if (await git.pull() !== git.PullResponse.DID_PULL) {
        return;
    }

    let preventReload = false;
    const preventReloadButton = Button({
        text: "Stop"
    });
    preventReloadButton.onclick = () => {
        preventReload = true;
        snackbar.dismiss();
    }

    const snackbar = SnackBar({
        message: "Project has updated. Rebuilding...",
        button: preventReloadButton
    });

    buildSASS(fs)
        .then(() => {
            esbuild.build().then(() => {
                snackbar.dismiss();
                if (preventReload) return;
                window.location.reload();
            });
        });

}
if (await git.hasGit()) {
    checkForUpdates();
}

// 40
function setTitle(title: string) {
    const payload = new Uint8Array([40, ...serializeArgs([title])]);
    bridge(payload);
}

let lastTitleSeen = null;
setInterval(() => {
    if (!document.title) return;

    if (lastTitleSeen !== document.title) {
        setTitle(document.title);
    }
    lastTitleSeen = document.title;
}, 500);