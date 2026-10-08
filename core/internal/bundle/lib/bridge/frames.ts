// Stream data arrives as binary frames on one long-lived response per
// context (GET /stream) instead of a script evaluated per chunk.
//
// Frame: [streamId u8][flags u8][length u32 big endian][data]
// flags: 0 data, 1 end, 2 error (data is the error message)
//
// The host sends a hello frame (stream 0, empty) once it reads the frames
// of the context. Without it the host keeps evaluating stream chunks with
// window.fullstacked.onStreamData, which stays registered.

import { onStreamFrame } from "./duplex.ts";

export const FRAME_HEADER_SIZE = 6;

// time to receive the hello frame before falling back to evaluated chunks
const HELLO_TIMEOUT_MS = 3000;

type OnFrame = (streamId: number, flags: number, data: Uint8Array) => void;

// Parses frames from chunks cut anywhere. Each frame gets its own buffer,
// consumers may use the whole underlying buffer of the data.
export class FrameParser {
    private header = new Uint8Array(FRAME_HEADER_SIZE);
    private headerView = new DataView(this.header.buffer);
    private headerFilled = 0;

    private streamId = 0;
    private flags = 0;
    private data: Uint8Array<ArrayBuffer> = null;
    private dataFilled = 0;

    private onFrame: OnFrame;

    constructor(onFrame: OnFrame) {
        this.onFrame = onFrame;
    }

    push(chunk: Uint8Array) {
        let i = 0;
        while (i < chunk.byteLength) {
            if (this.data === null) {
                const n = Math.min(
                    FRAME_HEADER_SIZE - this.headerFilled,
                    chunk.byteLength - i
                );
                this.header.set(chunk.subarray(i, i + n), this.headerFilled);
                this.headerFilled += n;
                i += n;
                if (this.headerFilled < FRAME_HEADER_SIZE) {
                    return;
                }
                this.headerFilled = 0;

                const streamId = this.header[0];
                const flags = this.header[1];
                const length = this.headerView.getUint32(2);

                // whole data in this chunk
                if (chunk.byteLength - i >= length) {
                    this.onFrame(streamId, flags, chunk.slice(i, i + length));
                    i += length;
                    continue;
                }

                this.streamId = streamId;
                this.flags = flags;
                this.data = new Uint8Array(length);
                this.dataFilled = 0;
            }

            const n = Math.min(
                this.data.byteLength - this.dataFilled,
                chunk.byteLength - i
            );
            this.data.set(chunk.subarray(i, i + n), this.dataFilled);
            this.dataFilled += n;
            i += n;

            if (this.dataFilled === this.data.byteLength) {
                const data = this.data;
                this.data = null;
                this.onFrame(this.streamId, this.flags, data);
            }
        }
    }
}

// Hands a frame to its duplex, stream 0 is hello and keepalives
function dispatchFrame(streamId: number, flags: number, data: Uint8Array) {
    if (streamId === 0) return;
    // a throwing listener must not stop the reader of every stream
    try {
        onStreamFrame(streamId, flags, data);
    } catch (e) {
        console.error(e);
    }
}

// Creates the parser handing frames to the duplexes and a promise of the
// hello frame, false after HELLO_TIMEOUT_MS or once failed.
function frameReceiver() {
    let resolveHello: (received: boolean) => void;
    const hello = new Promise<boolean>((resolve) => (resolveHello = resolve));
    const timeout = setTimeout(() => resolveHello(false), HELLO_TIMEOUT_MS);

    const parser = new FrameParser((streamId, flags, data) => {
        if (streamId === 0) {
            clearTimeout(timeout);
            resolveHello(true);
        }
        dispatchFrame(streamId, flags, data);
    });

    const fail = () => {
        clearTimeout(timeout);
        resolveHello(false);
    };

    return { parser, hello, fail };
}

// Without the hello frame, the page keeps the evaluated chunks: the host
// must stop queueing frames before any stream starts.
async function detachFrameStream() {
    try {
        await fetch("/stream/detach", { cache: "no-store" });
    } catch {}
}

// Reads the frames from the body of GET /stream. Resolves true once the
// hello frame arrived, false to keep the evaluated chunks.
export async function readFrameStream(): Promise<boolean> {
    const { parser, hello, fail } = frameReceiver();
    const controller = new AbortController();

    // resolves true when the host ended the response
    const readResponse = async (frameParser: FrameParser) => {
        const response = await fetch("/stream", {
            signal: controller.signal,
            cache: "no-store"
        });
        if (!response.ok || !response.body) {
            return false;
        }
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) return true;
            frameParser.push(value);
        }
    };

    (async () => {
        try {
            await readResponse(parser);
        } catch {}
        fail();

        // the host ends a response (Android every ~1 GB, its length is
        // fixed) and the core keeps the queued frames for the next one
        if (!(await hello)) return;
        while (true) {
            try {
                if (!(await readResponse(new FrameParser(dispatchFrame)))) {
                    break;
                }
            } catch {
                break;
            }
        }
    })();

    const received = await hello;
    globalThis.fullstacked.streamTransport = received ? "frames" : "evaluated";
    if (!received) {
        controller.abort();
        await detachFrameStream();
    }
    return received;
}

// WebView2 reads a response stream entirely before answering, the host
// posts the frames in shared buffers instead.
export async function readFrameSharedBuffers(webview: {
    addEventListener(event: string, cb: (e: any) => void): void;
    removeEventListener(event: string, cb: (e: any) => void): void;
    releaseBuffer(buffer: ArrayBuffer): void;
}): Promise<boolean> {
    const { parser, hello, fail } = frameReceiver();

    const onSharedBuffer = (e: any) => {
        if (e.additionalData?.type !== "frames") return;
        const buffer: ArrayBuffer = e.getBuffer();
        try {
            parser.push(new Uint8Array(buffer));
        } finally {
            webview.releaseBuffer(buffer);
        }
    };
    webview.addEventListener("sharedbufferreceived", onSharedBuffer);

    try {
        const response = await fetch("/stream");
        if (!response.ok) {
            fail();
        }
    } catch {
        fail();
    }

    const received = await hello;
    globalThis.fullstacked.streamTransport = received
        ? "shared-buffers"
        : "evaluated";
    if (!received) {
        webview.removeEventListener("sharedbufferreceived", onSharedBuffer);
        await detachFrameStream();
    }
    return received;
}
