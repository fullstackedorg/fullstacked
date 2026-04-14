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

/**
 * Configuration options for the Socket class.
 */
type SocketOpts = {
    /** Whether to allow half-open TCP connections. */
    allowHalfOpen: boolean;
    /** Whether to enable keep-alive functionality. */
    keepAlive: boolean;
    /** The initial delay before the first keepalive probe is sent. */
    keepAliveInitialDelay: number;
    /** Whether to enable TCP_NODELAY. */
    noDelay: boolean;
    /** Callback and buffer for low-level reading. */
    onread: {
        buffer: Buffer | Uint8Array | Function;
        callback: (chunk: Buffer) => void;
    };
};

/**
 * Node.js net.Socket shim bridging to FullStacked core.
 */
export class Socket extends RealDuplex {
    private duplex: Duplex = null;

    constructor(options?: Partial<SocketOpts>) {
        super(options);
    }

    /**
     * Connect the socket to a remote host and port.
     */
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
                if (this.destroyed) return;
                this.push(Buffer.from(data));
            });
            this.duplex.on("close", () => {
                if (!this.destroyed) {
                    this.push(null);
                }
                this.emit("close");
            });
            this.emit("connect");
            this.emit("ready");
        });
    }

    _read(size: number) {
        // Data is pushed asynchronously from the duplex bridge
    }

    _write(
        chunk: any,
        encoding: string,
        callback: (error?: Error | null) => void
    ) {
        if (!this.duplex) {
            this.once("connect", () => this._write(chunk, encoding, callback));
            return;
        }

        this.duplex
            .write(chunk)
            .then(() => callback())
            .catch(callback);
    }

    _final(callback: (error?: Error | null) => void) {
        if (this.duplex) {
            this.duplex.end();
        }
        callback();
    }

    _destroy(error: Error | null, callback: (error: Error | null) => void) {
        if (this.duplex) {
            this.duplex.end();
        }
        callback(error);
    }

    setNoDelay(noDelay: boolean = true) {
        return this;
    }

    setKeepAlive(enable: boolean = false, initialDelay: number = 0) {
        return this;
    }

    private _timeoutId?: any;
    /**
     * Set the timeout for the socket.
     * @param timeout Timeout in milliseconds. 0 disables the timeout.
     * @param callback Callback executed when the 'timeout' event fires.
     */
    setTimeout(timeout: number, callback?: () => void) {
        if (this._timeoutId) clearTimeout(this._timeoutId);
        if (timeout > 0) {
            this._timeoutId = setTimeout(() => {
                if (callback) callback();
                this.emit("timeout");
            }, timeout);
        }
        return this;
    }

    ref() {
        return this;
    }

    unref() {
        if (this._timeoutId) clearTimeout(this._timeoutId);
        return this;
    }
}

type ConnectOpts = SocketOpts & {
    port: number;
    host: string;
    path: string;
};

type ConnectListener = () => void;

/**
 * Creates a new Socket and connects it to the specified host and port.
 */
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

/**
 * Identifies the version of the IP address in a string.
 * @returns 4 if IPv4, 6 if IPv6, 0 otherwise.
 */
export function isIP(addr: string) {
    return isIPv6(addr) ? 6 : isIPv4(addr) ? 4 : 0;
}

/**
 * Checks if the address is a valid IPv4 address.
 */
export function isIPv4(addr: string) {
    if (addr.length > maxIPv4Length) {
        return false;
    }

    const ipv4Regex =
        /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
    return ipv4Regex.test(addr);
}

/**
 * Checks if the address is a valid IPv6 address.
 */
export function isIPv6(addr: string) {
    if (addr.length > maxIPv6Length) {
        return false;
    }

    const ipv6Regex =
        /^(?:(?:[a-fA-F\d]{1,4}:){7}(?:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,2}|:)|(?:[a-fA-F\d]{1,4}:){4}(?:(?::[a-fA-F\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,3}|:)|(?:[a-fA-F\d]{1,4}:){3}(?:(?::[a-fA-F\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,4}|:)|(?:[a-fA-F\d]{1,4}:){2}(?:(?::[a-fA-F\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,5}|:)|(?:[a-fA-F\d]{1,4}:){1}(?:(?::[a-fA-F\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,6}|:)|(?::(?:(?::[a-fA-F\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,7}|:)))(?:%[0-9a-zA-Z]{1,})?$/;
    return ipv6Regex.test(addr);
}

const net = {
    Socket,
    connect,
    createConnection,
    isIP,
    isIPv4,
    isIPv6
};

export default net;
