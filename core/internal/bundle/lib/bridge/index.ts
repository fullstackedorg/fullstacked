import { deserialize, mergeUint8Arrays, serialize } from "./serialization.ts";
import {
    CoreCallResponseType,
    CoreModule,
    CoreResponseData,
    CoreResponseError,
    CoreResponseStream,
    SerializableData
} from "../@types/index.ts";
import { createDuplex } from "./duplex.ts";
import type platformBridgeType from "./platform/index.ts";

declare global {
    var bridge: bridge;
    var platformBridge: typeof platformBridgeType;
    var __dirname: string;
}

globalThis.__dirname = "/";

type BridgeOpts = {
    mod: CoreModule;
    fn: number;
    data?: SerializableData[];
};

type bridgeAsync = (opts: BridgeOpts) => Promise<SerializableData>;
type bridgeSync<T extends boolean> = (opts: BridgeOpts, sync: T) => T extends true ? SerializableData : Promise<SerializableData>;
type bridge = bridgeSync<boolean> & bridgeAsync;

async function init() {
    const platformBridge = (await import("./platform/index.ts")).default;
    globalThis.platformBridge = platformBridge;
    try {
        await platformBridge.ready;
    } catch {
        return;
    }

    let id = 0;
    globalThis.bridge = function (opts: BridgeOpts, sync?: boolean) {
        const preparePayload = () => {
            id = (id + 1) % 256;

            const data = opts.data
                ? mergeUint8Arrays(...opts.data.map(serialize))
                : null;
            const payload = new Uint8Array(5 + (data?.byteLength ?? 0));

            payload[0] = platformBridge.bridge.ctx;
            payload[1] = id;
            payload[2] = opts.mod;
            payload[3] = opts.fn;
            payload[4] = sync ? 1 : 0;
            if (data != null) {
                payload.set(data, 5);
            }
            return payload;
        };

        if (sync) {
            const payload = preparePayload();
            let responseBuffer = platformBridge.bridge.Sync(payload.buffer);
            if (!responseBuffer && platformBridge.bridge.GetResponseSync) {
                responseBuffer = platformBridge.bridge.GetResponseSync(id);
            }
            const response = processResponse(responseBuffer);
            if (response instanceof Error) {
                throw response;
            }
            return response;
        }

        return new Promise<SerializableData>(async (resolve, reject) => {
            const payload = preparePayload();
            const responseBuffer = await platformBridge.bridge.Async(
                payload.buffer
            );
            const response = processResponse(responseBuffer);
            if (response instanceof Error) {
                reject(response);
            } else {
                resolve(response);
            }
        });
    };

    if (!globalThis.process) {
        await import("process");
    }
}

if (!globalThis.bridge) {
    await init();
}

function processResponse(buffer: ArrayBuffer | void) {
    if (!buffer || buffer.byteLength === 0) {
        return new Error("received empty response");
    }

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
            const streamId = deserialize(buffer, 1).data as number;
            return createDuplex(streamId, bridge);
    }

    throw new Error("don't know how to process response from core");
}