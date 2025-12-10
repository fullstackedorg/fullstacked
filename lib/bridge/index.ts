import {
    Data,
    deserialize,
    mergeUint8Arrays,
    serialize
} from "./serialization";
import * as node from "./platform/node";
import {
    CoreData,
    CoreError,
    CoreResponseType,
    CoreStream,
    Module
} from "../@types/router";

enum Platform {
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

type BridgeSync = (payload: ArrayBuffer) => ArrayBuffer;
type BridgeAsync = (payload: ArrayBuffer) => Promise<ArrayBuffer>;

let bridges: {
    Sync: BridgeSync;
    Async: BridgeAsync;
} = null;
switch (platform) {
    case Platform.NODE:
        bridges = node;
        break;
    default:
        throw new Error("Brige not implemented for current platform");
}

type CoreResponse = Data[] | ReadableStream;

type BridgeOpts = {
    mod: Module;
    fn: number;
    args?: Data[];
};

export function bridge(opts: BridgeOpts, sync: true): CoreResponse;
export function bridge(opts: BridgeOpts, sync?: false): Promise<CoreResponse>;
export function bridge(opts: BridgeOpts, sync = false) {
    const serialized = [];
    const payload = mergeUint8Arrays(...serialized).buffer;

    if (sync) {
        const responseBuffer = bridges.Sync(payload);
        const response = processResponse(responseBuffer);
        if (response instanceof Error) {
            throw response;
        }
        return response;
    }

    return new Promise<CoreResponse>(async (resolve, reject) => {
        const responseBuffer = await bridges.Async(payload);
        const response = processResponse(responseBuffer);
        if (response instanceof Error) {
            reject(response);
        } else {
            resolve(response);
        }
    });
}

function processResponse(buffer: ArrayBuffer) {
    const responseType = buffer[0] as CoreResponseType;
    switch (responseType) {
        case CoreError:
            return new Error("error from bridge");
        case CoreData:
            return deserialize(buffer.slice(1));
        case CoreStream:
            return new ReadableStream();
    }

    throw new Error("don't know how to process response from core");
}
