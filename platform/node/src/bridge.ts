import http from "node:http";
import type { Core } from "./core.ts";

// The bridge between a page and the core (see core/internal/bundle/lib/bridge
// and perfs/porting.md), over HTTP:
// - GET /stream: the stream data as binary frames, its connection tells
//   whether the page is still there
// - every other request of the page (static files, POST /call and /sync...)
//   is answered by the core, in order (one JS thread)
//
// onPageGone runs once the context ended or no page read the stream for 5s.
export function createBridge(core: Core, ctx: number, onPageGone: () => void) {
    let streams = 0;
    let goneTimeout: NodeJS.Timeout | undefined;

    const streamClosed = () => {
        streams--;
        if (streams > 0) return;
        if (!core.check(ctx)) {
            onPageGone();
        } else {
            goneTimeout = setTimeout(onPageGone, 5000);
        }
    };

    // until the context ends, the page reloads or goes away
    const stream = (res: http.ServerResponse) => {
        const gen = core.streamAttach(ctx);
        if (gen < 0) {
            res.writeHead(404);
            return res.end();
        }

        clearTimeout(goneTimeout);
        streams++;
        res.writeHead(200, {
            "content-type": "application/octet-stream",
            "cache-control": "no-cache"
        });
        res.flushHeaders();

        let ended = false;
        res.on("close", () => {
            if (!ended) {
                ended = true;
                core.streamDetach(ctx, gen);
            }
            streamClosed();
        });

        core.streamStart(ctx, gen, (frames) => {
            if (frames === null) {
                ended = true;
                res.end();
            } else {
                res.write(frames);
            }
        });
    };

    return {
        async request(
            req: http.IncomingMessage,
            res: http.ServerResponse,
            path: string
        ) {
            if (path === "/stream") {
                return stream(res);
            }
            const body =
                req.method === "POST" ? await readBody(req) : undefined;
            const [status, mimeType, data] = core.request(ctx, path, body);
            res.writeHead(status, {
                "content-type": mimeType,
                "content-length": data.byteLength,
                "cache-control": "no-cache"
            });
            res.end(data);
        },
        close() {
            clearTimeout(goneTimeout);
        }
    };
}

export function readBody(req: http.IncomingMessage) {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
