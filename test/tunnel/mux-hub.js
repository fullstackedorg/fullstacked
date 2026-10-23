import { EventEmitter } from "node:events";
import net from "node:net";

// The hub's side of the tunnel mux protocol, for the test hubs. Each binary
// message is one frame: [type u8][stream id u32 BE][payload]. The runtime
// opens streams (OPEN), the hub answers OPENED or RESET (the dial failed);
// DATA flows within a credit the receiver gives back with WINDOW (u32
// increment); FIN ends one side, RESET (utf-8 reason) both.
export const OPEN = 1;
export const OPENED = 2;
export const DATA = 3;
export const WINDOW = 4;
export const FIN = 5;
export const RESET = 6;

const MAX_DATA_PAYLOAD = 32 * 1024;

export function encodeFrame(type, id, payload) {
    const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
    const frame = Buffer.allocUnsafe(5 + body.byteLength);
    frame[0] = type;
    frame.writeUInt32BE(id, 1);
    body.copy(frame, 5);
    return frame;
}

function toBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

// A stream of a session: opened(), write(), end() (FIN), reset(reason);
// emits "data", "end" (the runtime's FIN) and "close" (RESET either way, or
// the session closing). The runtime's DATA is credited back as it arrives.
class HubStream extends EventEmitter {
    constructor(ws, id) {
        super();
        this.ws = ws;
        this.id = id;
        this.closed = false;
    }

    send(type, payload) {
        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(encodeFrame(type, this.id, payload), { binary: true });
        }
    }

    opened() {
        this.send(OPENED);
    }

    write(data) {
        for (let i = 0; i < data.byteLength; i += MAX_DATA_PAYLOAD) {
            this.send(DATA, data.subarray(i, i + MAX_DATA_PAYLOAD));
        }
    }

    end() {
        if (!this.closed) this.send(FIN);
    }

    reset(reason = "stream_error") {
        if (this.closed) return;
        this.send(RESET, reason);
        this.finish();
    }

    finish() {
        if (this.closed) return;
        this.closed = true;
        this.emit("close");
    }
}

// Serves the mux protocol on ws: onStream(stream) for every OPEN.
export function serveMux(ws, onStream) {
    const streams = new Map();
    ws.on("message", (data) => {
        const message = toBuffer(data);
        if (message.byteLength < 5) return;
        const type = message[0];
        const id = message.readUInt32BE(1);
        const payload = message.subarray(5);
        if (type === OPEN) {
            const stream = new HubStream(ws, id);
            streams.set(id, stream);
            stream.once("close", () => streams.delete(id));
            onStream(stream);
            return;
        }
        const stream = streams.get(id);
        if (!stream) return;
        if (type === DATA) {
            const credit = Buffer.allocUnsafe(4);
            credit.writeUInt32BE(payload.byteLength);
            stream.send(WINDOW, credit);
            stream.emit("data", Buffer.from(payload));
        } else if (type === FIN) {
            stream.emit("end");
        } else if (type === RESET) {
            stream.finish();
        }
    });
    ws.on("close", () => {
        for (const stream of streams.values()) stream.finish();
    });
}

// Connects stream to the TCP server at port, like the hub with a direct
// tunnel: OPENED once the target is up (after delayMs), its bytes buffered
// until then, each side's end carried to the other.
export function spliceToTcp(stream, port, delayMs = 0) {
    const pending = [];
    let target = null;
    let ended = false; // the runtime sent FIN
    let targetEnded = false;
    stream.on("data", (data) =>
        target ? target.write(data) : pending.push(data)
    );
    stream.on("end", () => {
        ended = true;
        target?.end();
    });
    stream.on("close", () => target?.destroy());

    setTimeout(() => {
        if (stream.closed) return;
        target = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
        target.on("connect", () => {
            stream.opened();
            pending.forEach((data) => target.write(data));
            pending.length = 0;
            if (ended) target.end();
        });
        target.on("data", (data) => stream.write(data));
        target.on("end", () => {
            targetEnded = true;
            stream.end();
        });
        target.on("error", () => stream.reset("target_close"));
        // both sides ended: the stream is done, else the target dropped
        target.on("close", () =>
            ended && targetEnded
                ? stream.finish()
                : stream.reset("target_close")
        );
    }, delayMs);
}
