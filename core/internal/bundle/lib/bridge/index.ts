import { deserialize, mergeUint8Arrays, serialize } from "./serialization.ts";
import {
    CoreCallResponseType,
    CoreModule,
    CoreResponseData,
    CoreResponseError,
    CoreResponseEventEmitter,
    CoreResponseStream,
    SerializableData
} from "../@types/index.ts";
import platformBridge from "./platform/index.ts";
import { createDuplex } from "./duplex.ts";

type BridgeOpts = {
    mod: CoreModule;
    fn: number;
    data?: SerializableData[];
};

let id = 0;

export function bridge(opts: BridgeOpts): Promise<SerializableData>;
export function bridge<T extends boolean>(
    opts: BridgeOpts,
    sync: T
): T extends true ? SerializableData : Promise<SerializableData>;
export function bridge(opts: BridgeOpts, sync?: boolean) {
    const preparePayload = () => {
        id = (id + 1) % 256;

        const data = opts.data
            ? mergeUint8Arrays(...opts.data.map(serialize))
            : null;
        const payload = new Uint8Array(4 + (data?.byteLength ?? 0));

        payload[0] = platformBridge.ctx;
        payload[1] = id;
        payload[2] = opts.mod;
        payload[3] = opts.fn;
        if (data != null) {
            payload.set(data, 4);
        }
        return payload;
    }

    if (sync) {
        if(platformBridge.ctx === null) {
            throw new Error("cannot call sync that quickly")
        }
        const payload = preparePayload()
        let responseBuffer = platformBridge.Sync(payload.buffer);
        if (responseBuffer == null && platformBridge.GetResponseSync) {
            responseBuffer = platformBridge.GetResponseSync(id);
        }
        const response = processResponse(responseBuffer);
        if (response instanceof Error) {
            throw response;
        }
        return response;
    }

    return new Promise<SerializableData>(async (resolve, reject) => {
        await platformBridge.ready;
        const payload = preparePayload();
        const responseBuffer = await platformBridge.Async(payload.buffer);
        const response = processResponse(responseBuffer);
        if (response instanceof Error) {
            reject(response);
        } else {
            resolve(response);
        }
    });
}

function processResponse(buffer: ArrayBuffer) {
    const responseType = new DataView(buffer, 0, 1).getUint8(
        0
    ) as CoreCallResponseType;
    switch (responseType) {
        case CoreResponseError:
            return new Error(
                `error from bridge: [${deserialize(buffer, 1).data}]`
            );
        case CoreResponseData:
            if (buffer.byteLength === 1) {
                return undefined;
            }
            return deserialize(buffer, 1).data;
        case CoreResponseStream:
            const streamId = deserialize(buffer, 1).data as number
            return createDuplex(streamId);
        case CoreResponseEventEmitter:
            throw new Error("not yet implemented");
    }

    throw new Error("don't know how to process response from core");
}
