import { toByteArray } from "./base64.ts";
import { SerializableData, Stream } from "../@types/index.ts";
import { Close, Open, Write, WriteEvent } from "../@types/stream.ts";
import { mergeUint8Arrays } from "./serialization.ts";
import { createEventEmitter } from "./eventEmitter.ts";

type DuplexItem = {
    opening: Promise<void> | null;
    open: boolean;
    done: boolean;
    listeners: {
        data: Set<(chunk: Uint8Array) => void>;
        close: Set<() => void>;
        error: Set<(err: Error) => void>;
    };
    pendingData: Uint8Array[];
    asyncRead: {
        promise?: { resolve: () => void; reject: (reason: any) => void };
        data: Uint8Array | null;
    } | null;
    queuedPackets: (ArrayBuffer | string)[];
    error?: Error;
};

const activeDuplexes = new Map<number, DuplexItem[]>();

function onStreamData(id: number, payload: ArrayBuffer | string) {
    const workerStreams = globalThis.fullstacked.workerStreams;
    if (workerStreams) {
        const worker = workerStreams.get(id);
        if (worker) {
            const chunk =
                typeof payload === "string"
                    ? toByteArray(payload)
                    : new Uint8Array(payload);
            if (chunk[0] === 1) {
                workerStreams.delete(id);
            }

            worker.postMessage(
                {
                    type: "on-stream-data",
                    streamId: id,
                    payload
                },
                [payload].filter((p) => p instanceof ArrayBuffer)
            );
            return;
        }
    }

    const duplexes = activeDuplexes.get(id);

    if (!duplexes || duplexes.length === 0) {
        globalThis.fullstacked.bridge({
            mod: Stream,
            fn: Close,
            data: [id]
        });
        return;
    }

    const duplex = duplexes[0];

    if (duplex.opening) {
        duplex.queuedPackets.push(payload);
        return;
    }

    processPayload(id, duplex, payload);
}

function processPayload(
    id: number,
    duplex: DuplexItem,
    payload: ArrayBuffer | string
) {
    const chunk =
        typeof payload === "string"
            ? toByteArray(payload)
            : new Uint8Array(payload);

    const isError = chunk[0] === 2;
    duplex.done = chunk[0] === 1 || isError;
    const data = chunk.slice(1);

    if (isError) {
        const errorMsg = new TextDecoder().decode(data);
        const err = new Error(errorMsg);
        duplex.error = err;
        duplex.listeners.error.forEach((cb) => cb(err));
        if (duplex.asyncRead?.promise?.reject) {
            duplex.asyncRead.promise.reject(err);
        }
    }

    if (duplex.listeners.data.size === 0 && !duplex.done && !isError) {
        duplex.pendingData.push(data);
    } else if (!isError) {
        duplex.listeners.data.forEach((cb) => cb(data));
    }

    if (duplex.done) {
        if (!isError) {
            duplex.listeners.close.forEach((cb) => cb());
        }
        // Remove from the queue once done
        const duplexes = activeDuplexes.get(id);
        if (duplexes) {
            const index = duplexes.indexOf(duplex);
            if (index !== -1) {
                duplexes.splice(index, 1);
                if (duplexes.length === 0) {
                    activeDuplexes.delete(id);
                }
            }
        }
    }

    if (duplex.asyncRead !== null && !isError) {
        duplex.asyncRead.data =
            duplex.asyncRead.data === null
                ? data
                : mergeUint8Arrays(duplex.asyncRead.data, data);

        duplex.asyncRead.promise?.resolve?.();
    }
}

type StreamData = string | Buffer | Uint8Array | DataView;

type EndCallback = () => void;

export interface Duplex extends ReadableStream<Uint8Array<ArrayBuffer>> {
    id: number;
    on(
        event: "data",
        callback: (chunk: StreamData, encoding?: string) => void
    ): void;
    on(event: "close", callback: EndCallback): void;
    on(event: "error", callback: (err: Error) => void): void;
    write(data: StreamData): Promise<any>;
    writeEvent(event: string, ...args: SerializableData[]): Promise<any>;
    end(): Promise<any>;
    promise(): Promise<any>;
    eventEmitter(): ReturnType<typeof createEventEmitter>;
    open(): Promise<void>;
}

const te = new TextEncoder();

export function createDuplex(id: number): Duplex {
    const duplex: DuplexItem = {
        opening: null,
        open: false,
        done: false,
        listeners: {
            data: new Set<(chunk: Uint8Array) => void>(),
            close: new Set<() => void>(),
            error: new Set<(err: Error) => void>()
        },
        pendingData: [],
        asyncRead: null,
        queuedPackets: []
    };

    if (!activeDuplexes.has(id)) {
        activeDuplexes.set(id, []);
    }
    activeDuplexes.get(id).push(duplex);

    const open = () => {
        if (duplex.open) {
            return Promise.resolve();
        }

        if (duplex.opening) {
            return duplex.opening;
        }

        duplex.opening = new Promise(async (resolveOpening) => {
            await globalThis.fullstacked.bridge({
                mod: Stream,
                fn: Open,
                data: [id]
            });

            duplex.open = true;
            duplex.opening = null;

            const packets = duplex.queuedPackets;
            duplex.queuedPackets = [];
            packets.forEach((p) => processPayload(id, duplex, p));

            resolveOpening();
        });

        return duplex.opening;
    };

    const read = () => {
        return new Promise<void>((resolve, reject) => {
            duplex.asyncRead.promise = { resolve, reject };
        });
    };

    const next = async () => {
        if (duplex.error) {
            throw duplex.error;
        }

        if (duplex.asyncRead === null) {
            let initialData: Uint8Array | null = null;
            if (duplex.pendingData.length > 0) {
                initialData = mergeUint8Arrays(...duplex.pendingData);
                duplex.pendingData = [];
            }
            duplex.asyncRead = {
                data: initialData
            };
        }

        if (duplex.done && !duplex.asyncRead.data) {
            return { done: true };
        }

        if (!duplex.open && !duplex.opening) {
            await open();
        }

        if (!duplex.asyncRead.data) {
            await read();
        }

        if (duplex.error) {
            throw duplex.error;
        }

        const value = duplex.asyncRead.data;
        duplex.asyncRead.data = null;

        return {
            value,
            done: value ? false : duplex.done
        };
    };

    const stream: any = {
        duplex: true,
        id,
        [Symbol.asyncIterator]() {
            return {
                next
            };
        }
    };

    stream.on = (event: string, cb: any) => {
        switch (event) {
            case "data":
                duplex.listeners.data.add(cb);
                if (duplex.pendingData.length > 0) {
                    duplex.pendingData.forEach(cb);
                    duplex.pendingData = [];
                }
                break;
            case "close":
                duplex.listeners.close.add(cb);
                break;
            case "error":
                duplex.listeners.error.add(cb);
                if (duplex.error) {
                    cb(duplex.error);
                }
                break;
        }

        if (!duplex.open && duplex.opening === null) {
            open();
        }
    };

    stream.write = async (data: Uint8Array | string) => {
        if (!duplex.open) {
            await open();
        }
        data = typeof data === "string" ? te.encode(data) : data;
        return globalThis.fullstacked.bridge({
            mod: Stream,
            fn: Write,
            data: [id, data]
        });
    };

    stream.writeEvent = async (event: string, ...args: SerializableData[]) => {
        if (!duplex.open) {
            await open();
        }
        return globalThis.fullstacked.bridge({
            mod: Stream,
            fn: WriteEvent,
            data: [id, event, ...args]
        });
    };

    stream.end = async () => {
        if (!duplex.open) {
            await open();
        }

        const res = await globalThis.fullstacked.bridge({
            mod: Stream,
            fn: Close,
            data: [id]
        });

        if (duplex.done) {
            return res;
        }

        await new Promise<void>((resolve) => {
            const onClose = () => {
                duplex.listeners.close.delete(onClose);
                resolve();
            };
            duplex.listeners.close.add(onClose);
        });

        return res;
    };

    stream.promise = async () => {
        let data = new Uint8Array();
        for await (const chunk of stream) {
            data = mergeUint8Arrays(data, chunk);
        }
        return data;
    };

    stream.eventEmitter = () => {
        return createEventEmitter(stream);
    };

    stream.open = open;

    stream.id = id;

    return stream;
}

export default onStreamData;
