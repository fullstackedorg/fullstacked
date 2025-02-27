import path from "path";
import os from "os";
import { setCallback, setDirectories } from "./call";
import { createWebView } from "./webview";
import { createInstance } from "./instance";

let deeplink: string = null,
    deeplinkMessaged = false;
if (process.argv.at(-1).startsWith("http")) {
    deeplink = process.argv.at(-1);
}

const root = path.resolve(os.homedir(), "FullStacked");
await setDirectories({
    root,
    config: path.resolve(os.homedir(), ".config", "fullstacked"),
    editor: path.resolve(process.cwd(), "..", "..", "out", "editor")
});

export const platform = new TextEncoder().encode("node");

type WebView = Awaited<ReturnType<typeof createWebView>>;

const webViews = new Map<string, WebView>();

const cb = (projectId: string, messageType: string, message: string) => {
    if (projectId === "*") {
        for (const w of webViews.values()) {
            w.message(messageType, message);
        }
        return;
    } else if (!projectId && messageType === "open") {
        openProject(message);
        return;
    }

    const webview = webViews.get(projectId);
    webview?.message(messageType, message);
};
await setCallback(cb);

async function openProject(id: string) {
    let webView = webViews.get(id);
    if (webView) {
        return;
    }

    const instance = createInstance(id);
    webView = await createWebView(instance, () => webViews.delete(id));
    webViews.set(id, webView);
}

const instanceEditor = createInstance("", true);
const instanceWebView = await createWebView(instanceEditor, null, () => {
    if (!deeplink || deeplinkMessaged) return;
    instanceWebView.message("deeplink", "fullstacked://" + deeplink);
    deeplinkMessaged = true;
});
webViews.set("", instanceWebView);

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
    process.on(signal, () => process.exit())
);
