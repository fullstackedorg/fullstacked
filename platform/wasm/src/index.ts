import "winbox/dist/css/winbox.min.css";
import wb from "winbox/src/js/winbox";
import type * as WinBoxType from "winbox";
import {
    deserializeArgs,
    numberTo4Bytes
} from "../../../fullstacked_modules/bridge/serialization";
import { toByteArray } from "../../../fullstacked_modules/base64";
import prettyBytes from "pretty-bytes";

const gitProxy = "https://p.fullstacked.org";

const WinBox = wb as WinBoxType.WinBoxConstructor;

declare global {
    class Go {
        importObject: WebAssembly.Imports;
        run: Function;
    }
    var directories: (
        root: string,
        config: string,
        editor: string,
        tmp: string
    ) => void;
    var call: (payload: Uint8Array) => Promise<string>; // base64
}

type FullStackedWindow = Window & {
    originalFetch?: typeof fetch;
    oncoremessage?: (messageType: string, message: string) => void;
    lib?: {
        call: (payload: Uint8Array) => Promise<string>; // base64
    };
};

const webviews = new Map<
    string,
    {
        window: FullStackedWindow;
        winbox?: WinBoxType;
    }
>();

const aspectRatio = 16 / 11;
const isLandscape = () => window.innerWidth > window.innerHeight;
const newWinboxHeight = () => {
    let height = window.innerHeight;
    if (isLandscape()) {
        height = window.innerHeight * 0.6;
    } else {
        height = newWinboxWidth() * aspectRatio;
    }
    if (height > window.innerHeight) {
        return window.innerHeight;
    }
    return height;
};
const newWinboxWidth = () => {
    let width = window.innerWidth;
    if (isLandscape()) {
        width = newWinboxHeight() * aspectRatio;
    } else {
        width = window.innerWidth * 0.6;
        if (width < 450) {
            width = window.innerWidth;
        }
    }
    if (width > window.innerWidth) {
        return window.innerWidth;
    }
    return width;
};

function createWindow(projectId: string) {
    const iframe = document.createElement("iframe");
    iframe.style.height = "100%";
    iframe.style.width = "100%";
    const height = newWinboxHeight();
    const width = newWinboxWidth();
    const winbox = new WinBox(projectId, {
        mount: iframe,
        height,
        width,
        x: window.innerWidth / 2 - width / 2,
        y: window.innerHeight / 2 - height / 2
    });
    webviews.set(projectId, {
        window: iframe.contentWindow,
        winbox
    });
    initProjectWindow(projectId);
}

globalThis.onmessageWASM = function (
    projectId: string,
    messageType: string,
    message: string
) {
    if (projectId === "*") {
        for (const w of webviews.values()) {
            w.window.oncoremessage?.(messageType, message);
        }
        return;
    } else if (projectId === "" && messageType === "open") {
        createWindow(message);
        return;
    }

    const webview = webviews.get(projectId);

    if (messageType === "title") {
        webview.winbox?.setTitle(message);
    } else {
        webview.window.oncoremessage?.(messageType, message);
    }
};

const createProgressBar = (filename: string) => {
    const container = document.createElement("div");
    container.classList.add("progress");

    const bar = document.createElement("div");
    bar.classList.add("bar");
    const barInner = document.createElement("div");
    bar.append(barInner);

    const text = document.createElement("div");
    text.classList.add("text");

    text.innerText = `Downloading ${filename}`;

    container.append(bar, text);

    document.querySelector("#download")?.append(container);

    return {
        setProgress(received: number, total: number) {
            barInner.style.width = (received / total) * 100 + "%";
            text.innerText = `Downloading ${filename} (${prettyBytes(received) + "/" + prettyBytes(total)})`;
        }
    };
};

async function download(
    baseUrl: string,
    filename: string
): Promise<Uint8Array<ArrayBuffer>> {
    const progress = createProgressBar(filename);

    const fileUrl = baseUrl + "/" + filename;

    const response = await fetch(fileUrl);
    const expectedSize = parseInt(response.headers.get("content-length"));
    let data = new Uint8Array(expectedSize * 1.3);
    const reader = response.body.getReader();
    let readCount = 0;
    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            data = data.slice(0, readCount);
            break;
        }

        data.set(value, readCount);
        readCount += value.byteLength;
        progress.setProgress(readCount, expectedSize);
    }
    reader.releaseLock();

    return data;
}

async function getAssetsBaseUrl() {
    if (process.env.baseUrl) {
        return process.env.baseUrl;
    }

    const versionFile = window.location.host
        .split(".")
        .find((part) => part === "demo")
        ? "release.txt"
        : "beta.txt";
    const response = await fetch(
        `https://files.fullstacked.org/wasm/${versionFile}`
    );
    const version: {
        major: number;
        minor: number;
        patch: number;
        build: number;
    } = await response.json();

    return `https://files.fullstacked.org/wasm/${version.major}.${version.minor}.${version.patch}/${version.build}`;
}

async function downloadAssets() {
    const baseUrl = await getAssetsBaseUrl();

    const [wasm, editor, wasmExec] = await Promise.all([
        download(baseUrl, "fullstacked.wasm"),
        download(baseUrl, "editor.zip"),
        download(baseUrl, "wasm_exec.js")
    ]);

    return new Promise<[Uint8Array, Uint8Array]>((res) => {
        const wasmExecBlob = new Blob([wasmExec], { type: "text/javascript" });
        const wasmExecUrl = URL.createObjectURL(wasmExecBlob);
        const script = document.createElement("script");
        script.onload = () => {
            res([editor, wasm]);
        };
        script.src = wasmExecUrl;
        document.body.append(script);
    });
}

let go: Go, editorZip: Uint8Array;
async function init() {
    const [editor, wasm] = await downloadAssets();
    editorZip = editor;
    go = new Go();
    const result = (await WebAssembly.instantiate(
        wasm,
        go.importObject
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    go.run(result.instance);
}
await init();

const dirs = {
    root: "/projects",
    config: "/config",
    editor: "/editor",
    tmp: "/.tmp"
};

directories(dirs.root, dirs.config, dirs.editor, dirs.tmp);

const te = new TextEncoder();
const editorDir = te.encode(dirs.editor);
const payload = new Uint8Array([
    1, // isEditor
    ...numberTo4Bytes(0), // no project id
    30, // UNZIP_BIN_TO_FILE
    4, // BUFFER
    ...numberTo4Bytes(editorZip.length),
    ...editorZip,
    2, // STRING
    ...numberTo4Bytes(editorDir.length),
    ...editorDir,
    1, // BOOLEAN
    ...numberTo4Bytes(1),
    1
]);
const unzipResult = deserializeArgs(toByteArray(await call(payload))).at(0);
if (!unzipResult) {
    console.error("Failed to unzip editor");
}

directories(dirs.root, dirs.config, dirs.editor, dirs.root + "/.tmp");

// add FullStacked main projects list for Demo purpose

const projectsListsConfig = {
    lists: [
        {
            url: "https://files.fullstacked.org/projects.json",
            name: "FullStacked",
            id: "org.fullstacked"
        }
    ]
};
const projectsListsConfigStr = JSON.stringify(projectsListsConfig);
const projectsListsConfigStrData = te.encode(projectsListsConfigStr);
const configType = "projects-lists";
const configTypeData = te.encode(configType);
const payloadWrite = new Uint8Array([
    1, // isEditor
    ...numberTo4Bytes(0), // no project id
    51, // CONFIG_SAVE
    2, // STRING
    ...numberTo4Bytes(configTypeData.length),
    ...configTypeData,
    2, // STRING
    ...numberTo4Bytes(projectsListsConfigStrData.length),
    ...projectsListsConfigStrData
]);
await call(payloadWrite);

// end add projects list

async function staticFileServing(projectId: string, pathname: string) {
    const projectIdData = te.encode(projectId);
    const pathnameData = te.encode(pathname);
    let payload = new Uint8Array([
        projectId === "" ? 1 : 0,
        ...numberTo4Bytes(projectIdData.byteLength),
        ...projectIdData,
        1, // Static File serving
        2, // STRING
        ...numberTo4Bytes(pathnameData.length),
        ...pathnameData
    ]);
    const responseRaw = await call(payload);
    const response = deserializeArgs(toByteArray(responseRaw));
    return response;
}

webviews.set("", { window });
initProjectWindow("");

async function initProjectWindow(projectId: string) {
    globalThis.td = new window.TextDecoder();

    const webview = webviews.get(projectId);
    if (!webview) return;

    webview.window.originalFetch = webview.window.fetch;
    webview.window.fetch = async function (
        url: string | Request,
        options: any
    ) {
        if (typeof url === "object") {
            return webview.window.originalFetch(url);
        }

        url = url.trim();
        if (url.startsWith("http")) {
            if (url.startsWith("https://github.com")) {
                if (options.method === "HEAD" && url.endsWith(".git")) {
                    url = url.slice(0, 0 - ".git".length);
                }

                url = `${gitProxy}?url=${encodeURIComponent(url)}`;
            }

            return webview.window.originalFetch(url, options);
        }

        if (url === "/platform") {
            return {
                text: () => new Promise<string>((res) => res("wasm"))
            };
        }

        const [_, contents] = await staticFileServing(projectId, url);
        return {
            text: () =>
                new Promise<string>((res) =>
                    res(globalThis.td.decode(contents))
                ),
            arrayBuffer: () =>
                new Promise<ArrayBuffer>((res) => res(contents.buffer))
        };
    } as any;

    if (projectId === "") {
        (window as any).lib = {
            call(payload: Uint8Array) {
                const data = new Uint8Array([
                    1, // isEditor
                    ...numberTo4Bytes(0), // no project id
                    ...payload
                ]);
                return call(data);
            }
        };
    } else {
        const projectIdData = te.encode(projectId);
        const header = new Uint8Array([
            0,
            ...numberTo4Bytes(projectIdData.byteLength),
            ...projectIdData
        ]);
        webview.window.lib = {
            call(payload: Uint8Array) {
                const data = new Uint8Array([...header, ...payload]);
                return call(data);
            }
        };
    }

    const [mimeType, contents] = await staticFileServing(projectId, "/");

    const parser = new DOMParser();
    const indexHTML = parser.parseFromString(
        globalThis.td.decode(contents),
        mimeType
    );

    Array.from(webview.window.document.body.children).forEach((child) =>
        child.remove()
    );

    // HEAD (link => style, script => script)
    indexHTML.head
        .querySelectorAll<HTMLElement>(":scope > *")
        .forEach(async (element) => {
            if (element instanceof HTMLScriptElement && element.src) {
                element = await scriptSrcToBlobURL(element, projectId);
            } else if (
                element instanceof HTMLLinkElement &&
                element.rel === "stylesheet"
            ) {
                const url = new URL(element.href);

                if (url.host === window.location.host) {
                    const [type, content] = await staticFileServing(
                        projectId,
                        url.pathname
                    );
                    const blob = new Blob([content], { type });
                    element.href = window.URL.createObjectURL(blob);
                    element.onload = () => {
                        checkForPageBGColor(webview);
                    };
                }
            } else if (element instanceof HTMLStyleElement) {
                let innerText = element.innerText;
                const urlImports = innerText.match(/url\(.*?\)/g);
                const promises = urlImports.map(async (i) => {
                    const url = i
                        .match(/\".*?\"/)
                        .at(0)
                        .slice(1, -1);
                    const [type, content] = await staticFileServing(
                        projectId,
                        url
                    );
                    const blob = new Blob([content], { type });
                    element.innerText = innerText.replace(
                        url,
                        URL.createObjectURL(blob)
                    );
                });
                await Promise.all(promises);
            }

            webview.window.document.head.append(element);
        });

    // BODY (script => script, img => img)
    indexHTML.body
        .querySelectorAll<HTMLElement>(":scope > *")
        .forEach(async (element) => {
            if (element instanceof HTMLScriptElement && element.src) {
                element = await scriptSrcToBlobURL(element, projectId);
            } else {
                element
                    .querySelectorAll<HTMLImageElement>("img")
                    .forEach((e) => replaceImageWithObjectURL(projectId, e));

                if (element instanceof HTMLImageElement) {
                    replaceImageWithObjectURL(projectId, element);
                }
            }

            webview.window.document.body.append(element);
        });

    checkForPageBGColor(webview);
}

function checkForPageBGColor(webview: {
    window: FullStackedWindow;
    winbox?: WinBoxType;
}) {
    const bgColor = webview.window.getComputedStyle(
        webview.window.document.documentElement
    ).backgroundColor;
    const hexColor = RGBAToHexA(bgColor, true);
    if (hexColor === "#000000" || !webview.winbox) return;
    webview.winbox?.setBackground(hexColor);
    if (isBgColorDark(hexColor)) {
        (webview.winbox?.dom as HTMLElement).querySelector<HTMLDivElement>(
            ".wb-header"
        ).style.color = "white";
        (webview.winbox?.dom as HTMLElement).querySelector<HTMLDivElement>(
            ".wb-control"
        ).style.filter = "invert(0)";
    } else {
        (webview.winbox?.dom as HTMLElement).querySelector<HTMLDivElement>(
            ".wb-header"
        ).style.color = "black";
        (webview.winbox?.dom as HTMLElement).querySelector<HTMLDivElement>(
            ".wb-control"
        ).style.filter = "invert(1)";
    }
}

async function scriptSrcToBlobURL(
    element: HTMLScriptElement,
    projectId: string
) {
    const url = new URL(element.src);

    if (url.host === window.location.host) {
        const script = window.document.createElement("script");
        script.type = element.type;
        const [type, content] = await staticFileServing(
            projectId,
            url.pathname
        );
        const blob = new Blob([content], { type });
        script.src = URL.createObjectURL(blob);
        return script;
    }

    return element;
}

async function replaceImageWithObjectURL(
    projectId: string,
    img: HTMLImageElement
) {
    const url = new URL(img.src);
    if (url.host !== window.location.host) {
        return;
    }
    img.removeAttribute("src");
    const [type, imageData] = await staticFileServing(projectId, url.pathname);
    const blob = new Blob([imageData], { type });
    const objURL = URL.createObjectURL(blob);
    img.src = objURL;
}

function RGBAToHexA(rgba: string, forceRemoveAlpha = false) {
    return (
        "#" +
        rgba
            .replace(/^rgba?\(|\s+|\)$/g, "") // Get's rgba / rgb string values
            .split(",") // splits them at ","
            .filter((string, index) => !forceRemoveAlpha || index !== 3)
            .map((string) => parseFloat(string)) // Converts them to numbers
            .map((number, index) =>
                index === 3 ? Math.round(number * 255) : number
            ) // Converts alpha to 255 number
            .map((number) => number.toString(16)) // Converts numbers to hex
            .map((string) => (string.length === 1 ? "0" + string : string)) // Adds 0 when length of one number is 1
            .join("")
    ); // Puts the array to togehter to a string
}

function isBgColorDark(bgColor: string) {
    return parseInt(bgColor.replace("#", ""), 16) < 0xffffff / 2;
}

const searchParams = new URLSearchParams(window.location.search);
const deeplink = searchParams.get("url");
if (deeplink) {
    const url = new URL(deeplink);
    if (url.pathname.startsWith("/fullstackedorg")) {
        launchDeeplink(url);
    }
}

async function launchDeeplink(url: URL) {
    while (globalThis.oncoremessage === undefined) {
        await new Promise((res) => setTimeout(res, 1000));
    }

    const urlStr = `fullstacked://${url.protocol.slice(0, -1)}//${url.host}${url.pathname}${url.search ? "?" + url.search : ""}`;
    globalThis.oncoremessage?.("deeplink", urlStr);
}
