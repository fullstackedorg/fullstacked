import http from "http";
import net from "net";
import open from "open";
import fastQueryString from "fast-querystring";
import { Duplex } from "stream";
import ws, { WebSocketServer } from "ws";
import { createInstance } from "./instance";
import { platform } from ".";
import {
    deserializeArgs,
    numberTo4Bytes
} from "../../../fullstacked_modules/bridge/serialization";
import { toByteArray } from "../../../fullstacked_modules/base64";

type Instance = ReturnType<typeof createInstance>;

const te = new TextEncoder();

export async function createWebView(
    instance: Instance,
    onClose?: () => void,
    onFirstConnection?: () => void
) {
    const port = await getNextAvailablePort();
    const server = http.createServer(createHandler(instance));

    const close = () => {
        if (onClose) {
            onClose();
            server.close();
        }
    };

    let closeTimeout: ReturnType<typeof setTimeout>,
        connectedOnce = false,
        messagesQueue: [string, string][] = [];
    const onSocketOpen = () => {
        if (!connectedOnce) {
            connectedOnce = true;
            messagesQueue.forEach(send);
            messagesQueue = [];
            onFirstConnection?.();
        }
        if (!closeTimeout) return;
        clearTimeout(closeTimeout);
        closeTimeout = null;
    };
    const onSocketClose = () => {
        if (webSockets.size !== 0) return;
        closeTimeout = setTimeout(close, 2000);
    };
    const webSockets = createWebSocketServer(server, {
        onSocketOpen,
        onSocketClose
    });
    const send = (m: [string, string]) => {
        const jsonStr = JSON.stringify(m);
        webSockets.forEach((ws) => ws.send(jsonStr));
    };
    server.listen(port);
    if (!process.env.NO_OPEN) {
        open(`http://localhost:${port}`);
    }
    return {
        message: (type: string, message: string) => {
            if (!connectedOnce) {
                messagesQueue.push([type, message]);
            } else {
                send([type, message]);
            }
        }
    };
}

function createHandler(instance: Instance) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        let [pathname, query] = req.url.split("?");
        pathname = decodeURI(pathname);

        if (pathname === "/platform") {
            res.writeHead(200, {
                "content-type": "text/plain",
                "content-length": platform.length
            });
            return res.end(platform);
        } else if (pathname === "/call") {
            const payload = await readBody(req);
            const data = await instance.call(payload);
            res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": data.length,
                "cache-control": "no-cache"
            });
            return res.end(data);
        }

        // Editor Only

        if (instance.isEditor && pathname === "/call-sync") {
            const parsedQuery = fastQueryString.parse(query);
            const payloadBase64 = decodeURIComponent(parsedQuery.payload);
            const payload = toByteArray(payloadBase64);
            const data = await instance.call(payload);
            res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": data.length,
                "cache-control": "no-cache"
            });
            return res.end(data);
        }

        // End Editor Only

        // Serve Static File

        const pathnameData = te.encode(pathname);

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
            const body = te.encode("Not Found");
            res.writeHead(404, {
                "content-type": "text/plain",
                "content-length": body.length,
                "cache-control": "no-cache"
            });
            return res.end(body);
        }

        res.writeHead(200, {
            "content-type": mimeType,
            "content-length": data.length,
            "cache-control": "no-cache"
        });
        res.end(data);
    };
}

function readBody(req: http.IncomingMessage) {
    return new Promise<Uint8Array>((resolve) => {
        const contentLengthStr = req.headers["content-length"] || "0";
        const contentLength = parseInt(contentLengthStr);
        if (!contentLength) {
            resolve(new Uint8Array());
            return;
        }

        const body = new Uint8Array(contentLength);
        let i = 0;
        req.on("data", (chunk: Buffer) => {
            for (let j = 0; j < chunk.byteLength; j++) {
                body[j + i] = chunk[j];
            }
            i += chunk.length;
        });
        req.on("end", () => resolve(body));
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

function createWebSocketServer(
    server: http.Server,
    cb: {
        onSocketOpen: () => void;
        onSocketClose: () => void;
    }
) {
    const webSockets = new Set<ws.WebSocket>();
    const wss = new WebSocketServer({ noServer: true });
    const onClose = (ws: ws.WebSocket) => {
        webSockets.delete(ws);
        cb.onSocketClose();
    };
    const handleUpgrade = (ws: ws.WebSocket) => {
        webSockets.add(ws);
        cb.onSocketOpen();

        ws.on("close", () => onClose(ws));
    };
    const onUpgrade = (...args: [InstanceType<any>, Duplex, Buffer]) => {
        wss.handleUpgrade(...args, handleUpgrade);
    };
    server.on("upgrade", onUpgrade);
    return webSockets;
}
