import net from "node:net";
import {
    bytesToNumber,
    DataType,
    deserializeArgs,
    numberTo4Bytes,
    serializeArgs
} from "../../fullstacked_modules/bridge/serialization";

export type Data = string | number | boolean | Uint8Array;

type DataSocket = {
    socket: net.Socket;
    buffer: Uint8Array;
    channel: DataChannel;
};

type DataChannel = {
    raw: boolean;
    receive: DataListener;
    dataSockets: Set<DataSocket>;
};

type Channels = Map<string, DataChannel>;

type DataServer = {
    server: net.Server;
    channels: Channels;
    connecting: Set<DataSocket>;
};

type DataListenerData = (data: Data[]) => void;
type DataListenerRaw = (data: Uint8Array) => void;

export type DataListener = (data: Uint8Array | Data[]) => void;

function receive(
    this: { listeners: Set<DataListener> },
    data: Uint8Array | Data[]
) {
    this.listeners.forEach((cb) => cb(data));
}

function send<Raw extends boolean>(
    data: Raw extends true ? Uint8Array : Data | Data[]
): void;
function send<Raw extends boolean>(
    this: { raw: boolean; dataSockets: DataSocket[] },
    data: Raw extends true ? Uint8Array : Data | Data[]
) {
    if (this.raw) {
        this.dataSockets.forEach(({ socket }) =>
            socket.write(data as Uint8Array)
        );
    } else {
        const args = Array.isArray(data) ? data : [data];
        const body = serializeArgs(args);
        const payload = new Uint8Array([
            ...numberTo4Bytes(body.length),
            ...body
        ]);
        this.dataSockets.forEach(({ socket }) => socket.write(payload));
    }
}

type ChannelRaw = {
    send: typeof send<true>;
    on(callback: DataListenerRaw): void;
    off(callback: DataListenerRaw): void;
};

type Channel = {
    send: typeof send<false>;
    on(callback: DataListenerData): void;
    off(callback: DataListenerData): void;
};

function createChannel(name: string, raw: true): ChannelRaw;
function createChannel(name: string, raw?: false): Channel;
function createChannel(
    this: { dataServer: DataServer },
    name: string,
    raw = false
) {
    const listeners = new Set<DataListener>();
    const dataSockets = new Set<DataSocket>();
    this.dataServer.channels.set(name, {
        raw,
        dataSockets,
        receive: receive.bind({ listeners })
    });

    return {
        send: send.bind({ raw, dataSockets }) as typeof send,
        on(callback: DataListener) {
            listeners.add(callback);
        },
        off(callback: DataListener) {
            listeners.delete(callback);
        }
    };
}

const td = new TextDecoder();

function tryUpgrade(server: DataServer, dataSocket: DataSocket) {
    if (dataSocket.buffer.at(0) !== DataType.STRING) {
        dataSocket.socket.end();
        return false;
    }

    if (dataSocket.buffer.byteLength < 5) return false;

    const dataLength = bytesToNumber(dataSocket.buffer.slice(1, 5));
    if (dataLength > dataSocket.buffer.byteLength - 5) return false;

    const channelName = td.decode(dataSocket.buffer.slice(5, 5 + dataLength));
    if (!server.channels.has(channelName)) {
        dataSocket.socket.end();
        console.log(
            `Socket trying to connect to unknown channel [${channelName}]`
        );
        return false;
    }

    console.log(`Socket upgrading to channel [${channelName}]`);

    dataSocket.buffer = dataSocket.buffer.slice(5 + dataLength);
    dataSocket.channel = server.channels.get(channelName);
    dataSocket.channel.dataSockets.add(dataSocket);
    server.connecting.delete(dataSocket);
    dataSocket.socket.on("close", () =>
        server.channels.get(channelName)?.dataSockets?.delete(dataSocket)
    );
    return true;
}

function tryReceive(dataSocket: DataSocket) {
    if (dataSocket.channel.raw) {
        dataSocket.channel.receive(dataSocket.buffer);
        dataSocket.buffer = new Uint8Array();
        return false;
    }

    if (dataSocket.buffer.byteLength < 4) return false;
    const bodyLength = bytesToNumber(dataSocket.buffer.slice(0, 4));
    if (bodyLength > dataSocket.buffer.byteLength - 4) return false;

    const body = dataSocket.buffer.slice(4, 4 + bodyLength);
    dataSocket.channel.receive(deserializeArgs(body));
    dataSocket.buffer = dataSocket.buffer.slice(4 + bodyLength);
    return true;
}

function onData(
    this: { server: DataServer; socket: DataSocket },
    chunk: Buffer<ArrayBufferLike>
) {
    const bufferSize = this.socket.buffer.byteLength + chunk.byteLength;
    const buffer = new Uint8Array(bufferSize);
    buffer.set(this.socket.buffer);
    buffer.set(chunk, this.socket.buffer.byteLength);
    this.socket.buffer = buffer;

    let keepProcessing: boolean;
    do {
        if (this.server.connecting.has(this.socket)) {
            keepProcessing = tryUpgrade(this.server, this.socket);
        } else {
            keepProcessing = tryReceive(this.socket);
        }
    } while (keepProcessing && this.socket.buffer.byteLength > 0);
}

function connectSocket(this: DataServer, socket: net.Socket) {
    const dataSocket: DataSocket = {
        socket,
        buffer: new Uint8Array(),
        channel: null
    };

    this.connecting.add(dataSocket);
    socket.on("data", onData.bind({ server: this, socket: dataSocket }));
    socket.on("close", () => this.connecting.delete(dataSocket));
}

export function createServer(port: number, hostname?: string) {
    const dataServer: DataServer = {
        server: net.createServer(),
        channels: new Map(),
        connecting: new Set()
    };
    dataServer.server.on("connection", connectSocket.bind(dataServer));
    dataServer.server.listen(port, hostname);
    return {
        dataServer,
        createChannel,
        end() {
            this.dataServer.server.close();
        }
    };
}
