// nodejs source: https://nodejs.org/docs/latest/api/net.html

import "buffer";
import { bridge } from "../bridge/index.ts";
import { Net } from "../@types/index.ts";
import { Connect } from "../@types/net.ts";
import { Duplex } from "../bridge/duplex.ts";
import { Duplex as RealDuplex } from "stream";

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

export class Socket extends RealDuplex {
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

    // @ts-ignore
    end(data: Uint8Array) {
        this.duplex.end(data);
        return this;
    }

    destroy(error?: Error) {
        this.duplex.end();
        return this;
    }

    // @ts-ignore
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

    pipe(destination: any, options?: { end?: boolean }) {
        return this as any;
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

const maxIPv4Length = 15;
const maxIPv6Length = 45;

export function isIP(addr: string) {
    return isIPv6(addr) ? 6 : isIPv4(addr) ? 4 : 0;
}

export function isIPv4(addr: string) {
    if (addr.length > maxIPv4Length) {
        return false;
    }

    const ipv4Regex =
        /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
    return ipv4Regex.test(addr);
}

export function isIPv6(addr: string) {
    if (addr.length > maxIPv6Length) {
        return false;
    }

    const ipv6Regex =
        /^(?:(?:[a-fA-F\d]{1,4}:){7}(?:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,2}|:)|(?:[a-fA-F\d]{1,4}:){4}(?:(?::[a-fA-F\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,3}|:)|(?:[a-fA-F\d]{1,4}:){3}(?:(?::[a-fA-F\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,4}|:)|(?:[a-fA-F\d]{1,4}:){2}(?:(?::[a-fA-F\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,5}|:)|(?:[a-fA-F\d]{1,4}:){1}(?:(?::[a-fA-F\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,6}|:)|(?::(?:(?::[a-fA-F\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,7}|:)))(?:%[0-9a-zA-Z]{1,})?$/;
    return ipv6Regex.test(addr);
}

export default {
    Socket,
    connect,
    createConnection
};
