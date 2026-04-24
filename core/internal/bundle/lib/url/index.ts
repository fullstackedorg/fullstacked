import { Buffer } from "buffer";
import os from "../os/index.ts";

const isWindows = os.platform() === "win32";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export function domainToASCII(domain: string): string {
    if (domain === "") return "";
    try {
        return new URL(`http://${domain}`).hostname;
    } catch {
        return domain;
    }
}

export function domainToUnicode(domain: string): string {
    return domain;
}

export function fileURLToPath(url: string | URL, options?: any): string {
    let parsed: URL;
    if (typeof url === "string") {
        parsed = new URL(url);
    } else {
        parsed = url;
    }

    if (parsed.protocol !== "file:") {
        throw new TypeError("Must be a file URL");
    }

    if (isWindows && parsed.hostname !== "") {
        // UNC path
        return `\\\\${parsed.hostname}${decodeURIComponent(parsed.pathname).replace(/\//g, "\\")}`;
    }

    let path = decodeURIComponent(parsed.pathname);

    if (isWindows) {
        if (/^\/[a-zA-Z]:\/?/.test(path)) {
            path = path.slice(1).replace(/\//g, "\\");
        } else {
            throw new TypeError("File URL path must be absolute");
        }
    }

    return path;
}

export function fileURLToPathBuffer(url: string | URL, options?: any): Buffer {
    const pathStr = fileURLToPath(url, options);
    return Buffer.from(pathStr);
}

export function format(urlObject: string | URL, options?: any): string {
    let parsed: URL;
    if (typeof urlObject === "string") {
        parsed = new URL(urlObject);
    } else {
        parsed = urlObject;
    }

    let formatted = parsed.toString();

    if (options) {
        let temp = new URL(formatted);
        if (options.auth === false) {
            temp.username = "";
            temp.password = "";
        }
        if (options.fragment === false) {
            temp.hash = "";
        }
        if (options.search === false) {
            temp.search = "";
        }
        formatted = temp.toString();
    }

    return formatted;
}

export function pathToFileURL(path: string, options?: any): URL {
    let resolved = path;

    if (isWindows) {
        // Windows absolute path
        if (/^[a-zA-Z]:\\/.test(path)) {
            resolved = `file:///${path.replace(/\\/g, "/")}`;
        } else if (path.startsWith("/")) {
            // Prepend drive letter if on Windows and starts with /
            let driveLetter = "C";
            if (typeof process !== "undefined" && process.cwd) {
                const match = process.cwd().match(/^([a-zA-Z]):/);
                if (match) driveLetter = match[1];
            }
            resolved = `file:///${driveLetter}:${path.replace(/\\/g, "/")}`;
        } else {
            // Assume absolute path mapping, typical for shims without full cwd context
            resolved = `file:///${path.replace(/\\/g, "/")}`;
        }
    } else {
        if (path.startsWith("/")) {
            resolved = `file://${path}`;
        } else {
            resolved = `file://${path}`;
        }
    }

    return new URL(resolved);
}

export function urlToHttpOptions(url: any): any {
    let parsed: URL;
    if (typeof url === "string") {
        parsed = new URL(url);
    } else {
        parsed = url;
    }

    const options: any = {
        protocol: parsed.protocol,
        hostname:
            typeof parsed.hostname === "string" &&
            parsed.hostname.startsWith("[")
                ? parsed.hostname.slice(1, -1)
                : parsed.hostname,
        hash: parsed.hash,
        search: parsed.search,
        pathname: parsed.pathname,
        path: `${parsed.pathname || ""}${parsed.search || ""}`,
        href: parsed.href
    };

    if (parsed.port !== "") {
        options.port = Number(parsed.port);
    }

    if (parsed.username || parsed.password) {
        options.auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    }

    return options;
}

const url = {
    URL,
    URLSearchParams,
    domainToASCII,
    domainToUnicode,
    fileURLToPath,
    fileURLToPathBuffer,
    format,
    pathToFileURL,
    urlToHttpOptions
};

export default url;
