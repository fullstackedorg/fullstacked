import { bridge } from "../bridge";
import {
    deserializeArgs,
    numberTo4Bytes,
    serializeArgs
} from "../bridge/serialization";
import core_message from "../core_message";
import { toByteArray } from "../base64";

export type Data = string | number | boolean | Uint8Array;

type DataChannelCallback = (data: Data[]) => void;

type DataChannel = {
    send(...args: Data[]): void;
    on(callback: DataChannelCallback): void;
    off(callback: DataChannelCallback): void;
};

type DataChannelRawCallback = (data: Uint8Array) => void;

type DataChannelRaw = {
    send(buffer: Uint8Array): void;
    on(callback: DataChannelRawCallback): void;
    off(callback: DataChannelRawCallback): void;
};

type Channel = {
    raw: false;
    listeners: Set<DataChannelCallback>;
};

type ChannelRaw = {
    raw: true;
    listeners: Set<DataChannelRawCallback>;
};

const channels = new Map<string, Channel | ChannelRaw>();

// 20
export function connect(
    name: string,
    port: number,
    host?: string,
    raw?: false
): Promise<DataChannel>;
export function connect(
    name: string,
    port: number,
    host: string,
    raw: true
): Promise<DataChannelRaw>;
export function connect(
    name: string,
    port: number,
    host = "localhost",
    raw = false
) {
    const payload = new Uint8Array([
        20,
        ...serializeArgs([name, port, host, raw])
    ]);

    const transformer = ([channelId]) => {
        if (raw) {
            const listeners = new Set<DataChannelRawCallback>();

            const channel: ChannelRaw = {
                raw: true,
                listeners
            };

            channels.set(channelId, channel);

            core_message.addListener("channel-" + channelId, (dataStr) => {
                const data = toByteArray(dataStr);
                listeners.forEach((cb) => cb(data));
            });

            return {
                send: (data) => send(channelId, data),
                on: (cb) => listeners.add(cb),
                off: (cb) => listeners.add(cb)
            } as DataChannelRaw;
        } else {
            const listeners = new Set<DataChannelCallback>();

            const channel: Channel = {
                raw: false,
                listeners
            };

            core_message.addListener("channel-" + channelId, (dataStr) => {
                const data = toByteArray(dataStr);
                listeners.forEach((cb) => cb(deserializeArgs(data)));
            });

            channels.set(channelId, channel);

            return {
                send: (...data) => {
                    const body = serializeArgs(data);
                    send(
                        channelId,
                        new Uint8Array([
                            ...numberTo4Bytes(body.byteLength),
                            ...body
                        ])
                    );
                },
                on: (cb) => listeners.add(cb),
                off: (cb) => listeners.add(cb)
            } as DataChannel;
        }
    };

    return bridge(payload, transformer);
}

// 21
function send(channelId: string, data: Uint8Array) {
    const payload = new Uint8Array([21, ...serializeArgs([channelId, data])]);

    return bridge(payload);
}
