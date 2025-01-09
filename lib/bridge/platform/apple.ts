import { Bridge } from "..";
import { fromByteArray, toByteArray } from "../../base64";
import { bytesToNumber, deserializeArgs, getLowestKeyIdAvailable, numberTo4Bytes } from "../serialization";

const requests = new Map<number, (data: Uint8Array) => void>();

export const BridgeApple: Bridge = (
    payload: Uint8Array,
    transformer?: (responseArgs: any[]) => any
) => {
    const requestId = getLowestKeyIdAvailable(requests);

    const base64 = fromByteArray(
        new Uint8Array([...numberTo4Bytes(requestId), ...payload])
    );

    return new Promise((resolve) => {
        requests.set(requestId, (data) => {
            const args = deserializeArgs(data);

            if (transformer) {
                return resolve(transformer(args));
            }

            resolve(args);
        });
        globalThis.webkit.messageHandlers.bridge.postMessage(base64);
    });
};

export function initRespondApple() {
    globalThis.respond = (base64: string) => {
        const data = toByteArray(base64);
        const id = bytesToNumber(data.slice(0, 4));
        const resolver = requests.get(id);
        resolver(data.slice(4));
        requests.delete(id);
    };
}
