import { Bridge } from "..";
import { fromByteArray, toByteArray } from "../../base64";
import {
    bytesToNumber,
    deserializeArgs,
    getLowestKeyIdAvailable,
    numberTo4Bytes
} from "../serialization";

const pendingRequests: {
    payload: Uint8Array;
    transformer: (responseArgs: any[]) => any;
    resolve: (args: any) => void;
}[] = [];
let channel: any;

async function respond(
    payload: Uint8Array,
    transformer?: (responseArgs: any[]) => any
) {
    const payloadStr = fromByteArray(new Uint8Array([0, 0, 0, 0, ...payload]));

    const response = await channel.objects.bridge.call(payloadStr);
    const data = toByteArray(response);
    const args = deserializeArgs(data.slice(4));

    if (transformer) {
        return transformer(args);
    }

    return args;
}

export const BridgeLinuxQT: Bridge = (
    payload: Uint8Array,
    transformer?: (responseArgs: any[]) => any
) => {
    if (!channel) {
        return new Promise((resolve) => {
            pendingRequests.push({
                payload,
                transformer,
                resolve
            });
        });
    }

    return respond(payload, transformer);
};

export async function initRespondLinuxQT() {
    const script = document.createElement("script");
    script.src = "qrc:///qtwebchannel/qwebchannel.js";
    return new Promise<void>((channelReady) => {
        script.onload = () => {
            new globalThis.QWebChannel(
                globalThis.qt.webChannelTransport,
                (c) => {
                    channel = c;
                    pendingRequests.forEach(
                        ({ payload, transformer, resolve }) => {
                            respond(payload, transformer).then(resolve);
                        }
                    );
                    channel.objects.bridge.core_message.connect(function (
                        type: string,
                        message: string
                    ) {
                        globalThis.oncoremessage(type, message);
                    });
                    channelReady();
                }
            );
        };
        document.body.append(script);
    });
}
