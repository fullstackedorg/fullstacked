// nodejs source: https://nodejs.org/docs/latest/api/net.html

import "buffer";
import { bridge } from "../bridge/index.ts";
import { Net } from "../@types/index.ts";
import { Connect } from "../@types/net.ts";
import { Duplex } from "../bridge/duplex.ts";
import EventEmitter from "events";

function parseOptions(
    pathOrPortOrOptions: Partial<ConnectOpts> | string | number,
    connectListenerOrHost?: string | ConnectListener
) {
    const path =
        typeof pathOrPortOrOptions === "string"
            ? pathOrPortOrOptions
            : typeof pathOrPortOrOptions === "object"
              ? pathOrPortOrOptions?.path
              : null;

    // connect path
    if (path) {
        throw "socket to unix file unavailable";
    }

    const port =
        typeof pathOrPortOrOptions === "number"
            ? pathOrPortOrOptions
            : typeof pathOrPortOrOptions === "object"
              ? pathOrPortOrOptions?.port
              : null;

    if (!port) {
        throw "undefined port for socket connection";
    }

    const host =
        typeof connectListenerOrHost === "string"
            ? connectListenerOrHost
            : typeof pathOrPortOrOptions === "object"
              ? pathOrPortOrOptions?.host
              : null;

    const options =
        typeof pathOrPortOrOptions === "object" ? pathOrPortOrOptions : null;

    return {
        host,
        port,
        options
    };
}

type SocketOpts = {
    allowHalfOpen: boolean;
    // blockList
    // fd
    keepAlive: boolean;
    keepAliveInitialDelay: number;
    noDelay: boolean;
    onread: {
        buffer: Buffer | Uint8Array | Function;
        callback: (chunk: Buffer) => void;
    };
    // readable
    // signal
    // writable
};

export class Socket extends EventEmitter {
    private duplex: Duplex = null;
    writable: boolean = true;
    readable: boolean = true;
    _readableState: any = {
        ended: false
    };

    constructor(options?: Partial<SocketOpts>) {
        super();
    }

    connect(options: Partial<ConnectOpts>): void;
    connect(port: number, host?: string): void;
    connect(optionsOrPort: Partial<ConnectOpts> | number, maybeHost?: string) {
        const { host, port } = parseOptions(optionsOrPort, maybeHost);

        bridge({
            mod: Net,
            fn: Connect,
            data: [port, host]
        }).then((d) => {
            this.duplex = d;
            this.duplex.on("data", (data: Uint8Array) => {
                this.emit("data", Buffer.from(data));
            });
            this.duplex.on("close", () => this.emit("close"));
            this.emit("connect");
            this.emit("ready");
        });
    }

    end(data: Uint8Array) {
        this.duplex.end(data);
    }

    destroy() {
        this.duplex.end();
    }

    write(data: Uint8Array) {
        this.duplex.write(data);
        return this;
    }

    setNoDelay(noDelay: boolean) {
        return this;
    }

    setKeepAlive(enable: boolean, initialDelay: number) {
        return this;
    }

    setTimeout(timeout: number, callback?: () => void) {
        return this;
    }

    pause() {
        return this;
    }

    resume() {
        return this;
    }

    pipe() {
        return this;
    }

    ref() {
        return this;
    }

    unref() {
        return this;
    }
}

type ConnectOpts = SocketOpts & {
    port: number;
    host: string;
    path: string;
};

type ConnectListener = () => void;

export function connect(
    options: Partial<ConnectOpts>,
    connectListener?: ConnectListener
): Socket;
export function connect(
    path: string,
    connectListener?: ConnectListener
): Socket;
export function connect(
    port: number,
    host?: string,
    connectListener?: ConnectListener
): Socket;
export function connect(
    pathOrPortOrOptions: Partial<ConnectOpts> | string | number,
    connectListenerOrHost?: string | ConnectListener,
    connectListener?: ConnectListener
) {
    const { host, port, options } = parseOptions(
        pathOrPortOrOptions,
        connectListenerOrHost
    );

    const onConnectListener =
        typeof connectListenerOrHost === "function"
            ? connectListenerOrHost
            : connectListener;

    const socket = new Socket(options);

    if (onConnectListener) {
        socket.addListener("connect", onConnectListener);
    }

    socket.connect(port, host);

    return socket;
}

export const createConnection: typeof connect = (...args: any) =>
    connect(...(args as [any]));

export default {
    Socket,
    connect,
    createConnection
};
