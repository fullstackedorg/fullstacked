import { Bridge } from "..";
import { deserializeArgs } from "../serialization";

export const BridgeNode: Bridge = async (
    payload: Uint8Array<ArrayBuffer>,
    transformer?: (responseArgs: any[]) => any
) => {
    const response = await fetch("/call", {
        method: "POST",
        body: payload
    });
    const data = new Uint8Array(await response.arrayBuffer());
    const args = deserializeArgs(data);

    if (transformer) {
        return transformer(args);
    }

    return args;
};

export function initCallbackNode() {
    const url = new URL(globalThis.location.href);
    url.protocol = "ws:";
    return new Promise<void>((wsReady) => {
        const ws = new WebSocket(url.toString());
        ws.onmessage = (e) => {
            const [type, message] = JSON.parse(e.data);
            globalThis.oncoremessage(type, message);
        };
        ws.onopen = () => wsReady();
    });
}
