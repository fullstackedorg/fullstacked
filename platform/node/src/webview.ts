import http from "node:http";
import net from "node:net";
// import { Duplex } from "node:stream";
import open from "open";
// import { WebSocket, WebSocketServer } from "ws";
// import { getEnvVar } from ".";
import type { Core } from "./core.ts";
import {
    deserialize,
    deserializeAll,
    numberToUint4Bytes
} from "../../../core/internal/bundle/lib/bridge/serialization.ts";
import {
    Core as CoreModule,
    STRING
} from "../../../core/internal/bundle/lib/@types/index.ts";
import { StaticFile } from "../../../core/internal/bundle/lib/@types/router.ts";
import { fromByteArray } from "../../../core/internal/bundle/lib/bridge/base64.ts";

// export let mainPort = parseInt(getEnvVar("port"));
// if (!mainPort || isNaN(mainPort)) {
//     mainPort = 9000;
// }
const mainPort = 9000;

const te = new TextEncoder();

export async function createWebView(
    core: Core,
    directory: string,
    openBrowser = false
) {
    const ctx = core.start(directory);
    const port = await getNextAvailablePort(mainPort);
    const server = http.createServer(createHandler(core, ctx));

    const close = () => {
        core.stop(ctx);
        server.close();
    };

    // let closeTimeout: ReturnType<typeof setTimeout>,
    //     connectedOnce = false,
    //     messagesQueue: [string, string][] = [];
    // const onSocketOpen = () => {
    //     if (!connectedOnce) {
    //         connectedOnce = true;
    //         messagesQueue.forEach(send);
    //         messagesQueue = [];
    //     }
    //     if (!closeTimeout) return;
    //     clearTimeout(closeTimeout);
    //     closeTimeout = null;
    // };
    // const onSocketClose = () => {
    //     if (webSockets.size !== 0) return;
    //     closeTimeout = setTimeout(close, 2000);
    // };
    // const webSockets = createWebSocketServer(server, {
    //     onSocketOpen,
    //     onSocketClose
    // });
    // const send = (m: [string, string]) => {
    //     const jsonStr = JSON.stringify(m);
    //     webSockets.forEach((ws) => ws.send(jsonStr));
    // };

    server.listen(port);

    if (openBrowser) {
        open(`http://localhost:${port}`);
    }

    return {
        close
        // message: (type: string, message: string) => {
        //     if (!connectedOnce) {
        //         messagesQueue.push([type, message]);
        //     } else {
        //         send([type, message]);
        //     }
        // }
    };
}

async function coreCall(core: Core, req: http.IncomingMessage) {
    const payload = await readBody(req);
    const data = core.call(payload.buffer);
    return new Uint8Array(data);
}

function createHandler(core: Core, ctx: number) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        let [pathname] = req.url.split("?");
        pathname = decodeURI(pathname);

        if (pathname === "/ctx") {
            const ctxStr = ctx.toString();
            res.writeHead(200, {
                "content-type": "text/plain",
                "content-length": ctxStr.length
            });
            return res.end(ctxStr);
        } else if (pathname === "/call") {
            const payload = await coreCall(core, req);
            res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": payload.byteLength,
                "cache-control": "no-cache"
            });
            return res.end(payload);
        } else if (pathname === "/call-sync") {
            const payload = await coreCall(core, req);
            const payloadBase64 = fromByteArray(payload);
            res.writeHead(200, {
                "content-type": "text/plain",
                "content-length": payloadBase64.length,
                "cache-control": "no-cache"
            });
            return res.end(payloadBase64);
        }

        const staticFile = coreStaticFile(core, ctx, pathname);

        res.writeHead(staticFile.found ? 200 : 400, {
            "content-type": staticFile.mimeType,
            "content-length": staticFile.data.byteLength,
            "cache-control": "no-cache"
        });
        res.end(staticFile.data);
    };
}

export function coreStaticFile(
    core: Core,
    ctx: number,
    pathname: string
): {
    found: boolean;
    mimeType: string;
    data: Uint8Array;
} {
    const pathnameData = te.encode(pathname);
    const payload = new Uint8Array([
        ctx,
        0, // id
        CoreModule, // Module
        StaticFile, // Fn

        STRING,
        ...numberToUint4Bytes(pathnameData.length), // arg length
        ...pathnameData
    ]);
    const responseData = core.call(payload.buffer);
    const response: { data: Uint8Array<ArrayBuffer> } = deserialize(
        responseData.slice(1)
    );

    if (response.data.byteLength === 0) {
        return {
            found: false,
            mimeType: "text/plain",
            data: te.encode("not found")
        };
    }

    const [mimeType, data] = deserializeAll(response.data.buffer);

    return {
        found: true,
        mimeType,
        data
    };
}

const readBodyQueue: {
    req: http.IncomingMessage;
    resolve: (body: Uint8Array<ArrayBuffer>) => void;
}[] = [];
let processingRequestLock = false;
function processRequests() {
    if (processingRequestLock) {
        return;
    }
    const readBody = readBodyQueue.shift();
    if (!readBody) {
        return;
    }
    processingRequestLock = true;
    const { req, resolve } = readBody;

    const end = (body: Uint8Array<ArrayBuffer>) => {
        resolve(body);
        processingRequestLock = false;
        processRequests();
    };

    const contentLengthStr = req.headers["content-length"] || "0";
    const contentLength = parseInt(contentLengthStr);
    if (!contentLength) {
        return end(new Uint8Array());
    }

    const body = new Uint8Array(contentLength);
    let i = 0;
    req.on("data", (chunk: Buffer) => {
        for (let j = 0; j < chunk.byteLength; j++) {
            body[j + i] = chunk[j];
        }
        i += chunk.length;
    });
    req.on("end", () => end(body));
}

function readBody(req: http.IncomingMessage) {
    return new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
        readBodyQueue.push({ req, resolve });
        processRequests();
    });
}

function getNextAvailablePort(
    port: number = 9000,
    host = "0.0.0.0"
): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();

        const timeout = () => {
            resolve(port);
            socket.destroy();
        };

        const next = () => {
            socket.destroy();
            resolve(getNextAvailablePort(++port));
        };

        setTimeout(timeout, 200);
        socket.on("timeout", timeout);

        socket.on("connect", function () {
            next();
        });

        socket.on("error", function (exception) {
            if ((exception as any).code !== "ECONNREFUSED") {
                reject(exception);
            } else {
                timeout();
            }
        });

        socket.connect(port, host);
    });
}

// function createWebSocketServer(
//     server: http.Server,
//     cb: {
//         onSocketOpen: () => void;
//         onSocketClose: () => void;
//     }
// ) {
//     const webSockets = new Set<WebSocket>();
//     const wss = new WebSocketServer({ noServer: true });
//     const onClose = (ws: WebSocket) => {
//         webSockets.delete(ws);
//         cb.onSocketClose();
//     };
//     const handleUpgrade = (ws: WebSocket) => {
//         webSockets.add(ws);
//         cb.onSocketOpen();

//         ws.on("close", () => onClose(ws));
//     };
//     const onUpgrade = (...args: [InstanceType<any>, Duplex, Buffer]) => {
//         wss.handleUpgrade(...args, handleUpgrade);
//     };
//     server.on("upgrade", onUpgrade);
//     return webSockets;
// }
