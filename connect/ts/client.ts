import net from "node:net";
import {
    bytesToNumber,
    deserializeArgs,
    numberTo4Bytes,
    serializeArgs
} from "../../fullstacked_modules/bridge/serialization";
import { Data, DataListener } from "./server";

type DataSocketClient = {
    socket: net.Socket;
    buffer: Uint8Array;
    listeners: Set<DataListener>;
};

function trySend(dataSocketClient: DataSocketClient) {
    if (dataSocketClient.buffer.byteLength < 5) return false;
    const dataLength = bytesToNumber(dataSocketClient.buffer.slice(0, 4));
    if (dataLength > dataSocketClient.buffer.byteLength - 4) return false;
    const data = deserializeArgs(
        dataSocketClient.buffer.slice(4, 4 + dataLength)
    );
    dataSocketClient.listeners.forEach((cb) => cb(data));
    dataSocketClient.buffer = dataSocketClient.buffer.slice(4 + dataLength);
    return true;
}

function onData(this: DataSocketClient, chunk: Buffer<ArrayBufferLike>) {
    const bufferSize = this.buffer.byteLength + chunk.byteLength;
    const buffer = new Uint8Array(bufferSize);
    buffer.set(this.buffer);
    buffer.set(chunk, this.buffer.byteLength);
    this.buffer = buffer;

    let keepProcessing: boolean;
    do {
        keepProcessing = trySend(this);
    } while (keepProcessing && this.buffer.byteLength > 0);
}

export function connect(channel: string, port: number, host?: string) {
    const dataSocketClient: DataSocketClient = {
        socket: new net.Socket(),
        buffer: new Uint8Array(),
        listeners: new Set<DataListener>()
    };
    dataSocketClient.socket.connect(port, host);
    dataSocketClient.socket.write(serializeArgs([channel]));
    dataSocketClient.socket.on("data", onData.bind(dataSocketClient));

    const methods = {
        send(data: Data | Data[]) {
            const serialized = serializeArgs(
                Array.isArray(data) ? data : [data]
            );
            const payload = new Uint8Array([
                ...numberTo4Bytes(serialized.byteLength),
                ...serialized
            ]);
            dataSocketClient.socket.write(payload);
            return methods;
        },
        on(callback: DataListener) {
            dataSocketClient.listeners.add(callback);
            return methods;
        },
        off(callback: DataListener) {
            dataSocketClient.listeners.delete(callback);
            return methods;
        }
    };

    return methods;
}
