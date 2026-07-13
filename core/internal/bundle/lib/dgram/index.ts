import { EventEmitter } from "events";
import { Buffer } from "buffer";
import { Dgram } from "../@types/index.ts";
import { CreateSocket } from "../@types/dgram.ts";
import { Duplex } from "../bridge/duplex.ts";

type RemoteInfo = {
    address: string;
    family: string;
    port: number;
    size: number;
};

export class Socket extends EventEmitter {
    private type: string;
    private duplex: Duplex | null = null;
    private isBound: boolean = false;
    private bindQueue: Array<() => void> = [];

    constructor(type: string) {
        super();
        this.type = type;
    }

    bind(
        port?: number | (() => void),
        address?: string | (() => void),
        callback?: () => void
    ) {
        let p = 0;
        let a = "0.0.0.0";

        if (typeof port === "function") {
            callback = port;
        } else if (typeof port === "number") {
            p = port;
        }

        if (typeof address === "function") {
            callback = address;
        } else if (typeof address === "string") {
            a = address;
        }

        if (callback) {
            this.once("listening", callback);
        }

        bridge({
            mod: Dgram,
            fn: CreateSocket,
            data: [this.type, p, a]
        }).then((d: Duplex) => {
            this.duplex = d;

            const em = this.duplex.eventEmitter();
            em.on("listening", (addr: string, portNumber: number) => {
                this.isBound = true;
                this.emit("listening");
                while (this.bindQueue.length > 0) {
                    const cb = this.bindQueue.shift();
                    if (cb) cb();
                }
            });

            em.on(
                "message",
                (msg: Uint8Array, raddr: string, rport: number) => {
                    const rinfo: RemoteInfo = {
                        address: raddr,
                        family: this.type,
                        port: rport,
                        size: msg.byteLength
                    };
                    this.emit(
                        "message",
                        Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength),
                        rinfo
                    );
                }
            );

            em.on("error", (err: string) => {
                this.emit("error", new Error(err));
            });

            this.duplex.on("close", () => {
                this.emit("close");
            });
        });

        return this;
    }

    send(
        msg: string | Uint8Array,
        offsetOrPort?: number | string | any,
        lengthOrAddress?: number | string | any,
        portOrAddress?: number | string | any,
        addressOrDefault?: string | any,
        callback?: (error: Error | null, bytes: number) => void
    ) {
        let port = 0;
        let address = "0.0.0.0";
        let buf: Uint8Array;

        if (typeof msg === "string") {
            buf = Buffer.from(msg);
        } else {
            buf = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
        }

        if (
            typeof offsetOrPort === "number" &&
            typeof lengthOrAddress === "number"
        ) {
            buf = buf.subarray(offsetOrPort, offsetOrPort + lengthOrAddress);
            port = typeof portOrAddress === "number" ? portOrAddress : 0;
            address =
                typeof addressOrDefault === "string"
                    ? addressOrDefault
                    : "0.0.0.0";
            if (typeof arguments[5] === "function") callback = arguments[5];
        } else {
            port = typeof offsetOrPort === "number" ? offsetOrPort : 0;
            address =
                typeof lengthOrAddress === "string"
                    ? lengthOrAddress
                    : "0.0.0.0";
            if (typeof portOrAddress === "function") callback = portOrAddress;
        }

        const doSend = () => {
            if (this.duplex) {
                this.duplex.writeEvent("send", buf, port, address);
                if (callback) {
                    callback(null, buf.byteLength);
                }
            }
        };

        if (this.isBound && this.duplex) {
            doSend();
        } else if (this.duplex) {
            this.bindQueue.push(doSend);
        } else {
            this.bindQueue.push(doSend);
            // Implicit bind
            this.bind(0, "0.0.0.0");
        }
    }

    close(callback?: () => void) {
        if (callback) this.once("close", callback);
        if (this.duplex) {
            this.duplex.end();
        } else {
            this.emit("close");
        }
    }

    address() {
        return { address: "0.0.0.0", port: 0, family: this.type };
    }
}

export function createSocket(
    typeOrOptions: string | { type: string; reuseAddr?: boolean },
    callback?: (msg: Buffer, rinfo: RemoteInfo) => void
): Socket {
    let type =
        typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions.type;
    const socket = new Socket(type);
    if (callback) {
        socket.on("message", callback);
    }
    return socket;
}

const dgram = {
    Socket,
    createSocket
};

export default dgram;
