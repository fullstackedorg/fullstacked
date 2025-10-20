import { Bridge } from "..";
import { deserializeArgs } from "../serialization";

export const BridgeElectron: Bridge = async (
    payload: Uint8Array,
    transformer?: (responseArgs: any[]) => any
) => {
    const response = await (window as any).electronAPI.bridge(payload);
    const args = deserializeArgs(response);
    if (transformer) {
        return transformer(args);
    }
    return args;
};
