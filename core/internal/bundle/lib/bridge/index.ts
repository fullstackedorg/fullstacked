import { deserialize, mergeUint8Arrays, serialize } from "./serialization.ts";
import {
    Core,
    CoreCallResponseType,
    CoreModule,
    CoreResponseData,
    CoreResponseError,
    CoreResponseEventEmitter,
    CoreResponseStream,
    SerializableData
} from "../@types/index.ts";
import { toByteArray } from "./base64.ts";
import { OpenStream } from "../@types/router.ts";
import platformBridge from "./platform/index.ts";

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

    if (sync) {
        let responseBuffer = platformBridge.Sync(payload.buffer);
        if (responseBuffer == null && platformBridge.GetResponseSync) {
            responseBuffer = platformBridge.GetResponseSync(id);
        }
        const response = processResponse(id, responseBuffer);
        if (response instanceof Error) {
            throw response;
        }
        return response;
    }

    return new Promise<SerializableData>(async (resolve, reject) => {
        const responseBuffer = await platformBridge.Async(payload.buffer);
        const response = processResponse(id, responseBuffer);
        if (response instanceof Error) {
            reject(response);
        } else {
            resolve(response);
        }
    });
}

function processResponse(id: number, buffer: ArrayBuffer) {
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
            return createStream(id);
        case CoreResponseEventEmitter:
            throw new Error("not yet implemented");
    }

    throw new Error("don't know how to process response from core");
}

const activeStreams = new Map<
    number,
    {
        resolve: (data: { done: boolean; value: Uint8Array }) => void;
        reject: (reason: string) => void;
    }
>();

globalThis.callback = function (id: number, payload: ArrayBuffer | string) {
    const chunk =
        typeof payload === "string"
            ? toByteArray(payload)
            : new Uint8Array(payload);

    const done = chunk[0] === 1;
    const value = chunk.slice(1);

    const stream = activeStreams.get(id);
    stream?.resolve({ done, value });
};

function createStream(id: number) {
    let opened = false;

    const read = async () => {
        if (!opened) {
            const buffer = await bridge({
                mod: Core,
                fn: OpenStream,
                data: [id]
            });
            const done = buffer[0] == 1;
            const value = buffer.slice(1);
            opened = true;
            return { done, value };
        } else {
            return new Promise<{ done: boolean; value: Uint8Array }>(
                (resolve, reject) => {
                    activeStreams.set(id, { resolve, reject });
                }
            );
        }
    };

    const it = {
        next: read
    };

    return iteratorToStream(it as AsyncIterator<Uint8Array>);
}

// https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream#convert_an_iterator_or_async_iterator_to_a_stream
function iteratorToStream(iterator: AsyncIterator<Uint8Array>) {
    return new ReadableStream({
        async pull(controller) {
            const { value, done } = await iterator.next();

            if (value) {
                controller.enqueue(value);
            }
            if (done) {
                controller.close();
            }
        }
    });
}
