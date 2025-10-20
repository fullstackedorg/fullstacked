import { bridge } from "./bridge";
import { serializeArgs } from "./bridge/serialization";

// 100
export default function core_open(projectId: string) {
    const payload = new Uint8Array([100, ...serializeArgs([projectId])]);

    return bridge(payload);
}
