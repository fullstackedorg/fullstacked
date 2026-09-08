import { app, BrowserWindow, ipcMain, protocol, globalShortcut } from "electron";
import { createInstance } from "../node/src/instance";
import {
    deserializeArgs,
    numberTo4Bytes
} from "../../fullstacked_modules/bridge/serialization";
import { load, setDirectories, CoreCallbackListeners } from "../node/src/call";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { getLibPath } from "../node/src/lib";

function getLaunchDirectory(baseDir: string, skipInitialDir = false) {
    if (skipInitialDir) return baseDir;
    const configFile = path.resolve(baseDir, ".git", "config.json");
    if (!fs.existsSync(configFile)) return baseDir;
    try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        if (config?.initialDirectory && typeof config.initialDirectory === "string") {
            const initialDir = config.initialDirectory.trim();
            if (initialDir) {
                const subPath = initialDir.startsWith("/") ? initialDir.slice(1) : initialDir;
                return path.resolve(baseDir, subPath);
            }
        }
    } catch {}
    return baseDir;
}

app.whenReady().then(init);
app.on("window-all-closed", () => app.quit());

async function init() {
    protocol.handle("http", protocolHandler);

    load(
        await getLibPath(
            path.resolve(process.cwd(), "..", "..", "core", "bin")
        ),
        path.resolve(process.cwd(), "..", "node")
    );

    const cb = (projectId: string, messageType: string, message: string) => {
        if (projectId === "" && messageType === "open") {
            createView(message);
            return;
        }

        const window = instances.get(projectId)?.window;
        message = message.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
        window?.webContents?.executeJavaScript(
            `window.oncoremessage( \`${messageType}\`, \`${message}\` )`
        );
    };
    CoreCallbackListeners.add(cb);

    const root = path.resolve(os.homedir(), "FullStacked");
    const launchRoot = getLaunchDirectory(root, false);
    const editorDirectory = path.resolve(
        process.cwd(),
        "..",
        "..",
        "out",
        "build"
    );
    setDirectories({
        root: launchRoot,
        config: path.resolve(os.homedir(), ".config", "fullstacked"),
        editor: launchRoot !== root ? launchRoot : editorDirectory,
        tmp: path.resolve(root, ".tmp")
    });

    const kioskFlagIndex = process.argv.findIndex((arg) => arg === "--kiosk");
    if (kioskFlagIndex !== -1) {
        const initId = process.argv.at(kioskFlagIndex + 1);
        createView(initId);
        instances.get(initId).window.setFullScreen(true);
    } else {
        createView("");
    }

    globalShortcut.register("CommandOrControl+Shift+Escape", () => {
        panicRecovery();
    });
}

function panicRecovery() {
    for (const item of instances.values()) {
        try {
            item.window.close();
        } catch {}
    }
    instances.clear();

    const root = path.resolve(os.homedir(), "FullStacked");
    const editorDirectory = path.resolve(
        process.cwd(),
        "..",
        "..",
        "out",
        "build"
    );
    setDirectories({
        root,
        config: path.resolve(os.homedir(), ".config", "fullstacked"),
        editor: editorDirectory,
        tmp: path.resolve(root, ".tmp")
    });
    createView("", true);
}

const instances = new Map<
    string,
    {
        instance: ReturnType<typeof createInstance>;
        window: BrowserWindow;
    }
>();
function getInstance(url: URL) {
    const host = url.host.slice(0, -".localhost".length);
    return instances.get(host);
}

function createView(id: string, skipInitialDir = false) {
    const instance = createInstance(id, id === "");
    const window = new BrowserWindow({
        webPreferences: {
            preload: path.join(__dirname, "preload.js")
        }
    });
    window.setMenu(null);
    instances.set(id, { window, instance });
    const baseUrl = id ? `http://${id}.localhost` : "http://localhost";
    window.loadURL(skipInitialDir ? `${baseUrl}?skipInitialDir=true` : baseUrl);
}

ipcMain.handle("bridge", async (event, payload) => {
    const webContents = event.sender;
    const { instance } = getInstance(new URL(webContents.getURL()));
    const response = await instance.call(payload);
    return response;
});

const te = new TextEncoder();
const platform = te.encode("electron") as Uint8Array<ArrayBuffer>;

async function protocolHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { instance } = getInstance(url);

    if (url.pathname === "/platform") {
        return new Response(platform, {
            status: 200,
            headers: {
                "content-type": "text/plain",
                "content-length": platform.length.toString()
            }
        });
    }

    const pathnameData = te.encode(url.pathname);

    const payload = new Uint8Array([
        1, // Static File Serving

        2, // arg type: STRING
        ...numberTo4Bytes(pathnameData.length), // arg length
        ...pathnameData
    ]);
    const responseData = await instance.call(payload);
    const [mimeType, data] = deserializeArgs(responseData);

    // not found
    if (!mimeType) {
        return new Response("Not Found", {
            status: 404,
            headers: {
                "content-type": "text/plain",
                "content-length": "Not Found".length.toString(),
                "cache-control": "no-cache"
            }
        });
    }

    return new Response(data, {
        status: 200,
        headers: {
            "content-type": mimeType,
            "content-length": data.length,
            "cache-control": "no-cache"
        }
    });
}
