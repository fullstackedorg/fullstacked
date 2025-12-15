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

enum Platform {
    TEST = "test",
    NODE = "node",
    APPLE = "apple",
    ANDROID = "android",
    DOCKER = "docker",
    WINDOWS = "windows",
    WASM = "wasm",
    LINUX_GTK = "linux-gtk",
    LINUX_QT = "linux-qt",
    ELECTRON = "electron"
}

declare global {
    const platform: Platform;
}

/*
 *
 * if CallSync return null, we need to call GetResponseSync,
 * this allows to make the call in two parts and
 * hang on the GetResponseSync (using xmlhttprequest sync)
 *
 */
let coreBridge: {
    ctx: number;
    Async: (payload: ArrayBuffer) => Promise<ArrayBuffer>;
    Sync: (payload: ArrayBuffer) => ArrayBuffer;
    GetResponseSync?: (id: number) => ArrayBuffer;
} = null;
switch (platform) {
    case Platform.TEST:
        coreBridge = globalThis.bridges;
        break;
    case Platform.NODE:
        coreBridge = await import("./platform/node.ts");
        break;
    default:
        throw new Error("Brige not implemented for current platform");
}

type BridgeOpts = {
    mod: CoreModule;
    fn: number;
    data?: SerializableData[];
};

let id = 0;

export function bridge(opts: BridgeOpts, sync: true): SerializableData;
export function bridge(
    opts: BridgeOpts,
    sync?: false
): Promise<SerializableData>;
export function bridge(opts: BridgeOpts, sync = false) {
    const data = opts.data
        ? mergeUint8Arrays(...opts.data.map(serialize))
        : null;
    const payload = new Uint8Array(4 + (data?.byteLength ?? 0));

    payload[0] = coreBridge.ctx;
    payload[1] = id++;
    payload[2] = opts.mod;
    payload[3] = opts.fn;
    if (data != null) {
        payload.set(data, 4);
    }

    if (sync) {
        let responseBuffer = coreBridge.Sync(payload.buffer);
        if (responseBuffer == null && coreBridge.GetResponseSync) {
            responseBuffer = coreBridge.GetResponseSync(id);
        }
        const response = processResponse(responseBuffer);
        if (response instanceof Error) {
            throw response;
        }
        return response;
    }

    return new Promise<SerializableData>(async (resolve, reject) => {
        const responseBuffer = await coreBridge.Async(payload.buffer);
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
        case CoreResponseEventEmitter:
            throw new Error("not yet implemented");
    }

    throw new Error("don't know how to process response from core");
}
