import { Bridge } from "..";
import { fromByteArray, toByteArray } from "../../base64";
import {
    bytesToNumber,
    deserializeArgs,
    getLowestKeyIdAvailable,
    numberTo4Bytes
} from "../serialization";

const requests = new Map<number, (data: Uint8Array) => void>();

export const BridgeLinuxGTK: Bridge = (
    payload: Uint8Array,
    transformer?: (responseArgs: any[]) => any
) => {
    const requestId = getLowestKeyIdAvailable(requests);

    const base64 = fromByteArray(
        new Uint8Array([...numberTo4Bytes(requestId), ...payload])
    );

    return new Promise((resolve, reject) => {
        requests.set(requestId, (data) => {
            try {
                const args = deserializeArgs(data);
                if (transformer) {
                    return resolve(transformer(args));
                }
                resolve(args);
            } catch (e) {
                reject(e);
            }
        });
        globalThis.webkit.messageHandlers.bridge.postMessage(base64);
    });
};

export function initRespondLinuxGTK() {
    globalThis.respond = (base64: string) => {
        const data = toByteArray(base64);
        const id = bytesToNumber(data.slice(0, 4));
        console.log(id);
        const resolver = requests.get(id);
        resolver(data.slice(4));
        requests.delete(id);
    };
}
