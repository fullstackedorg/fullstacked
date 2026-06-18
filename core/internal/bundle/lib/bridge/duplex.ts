import { toByteArray } from "./base64.ts";
import { SerializableData, Stream } from "../@types/index.ts";
import { Close, Open, Write, WriteEvent } from "../@types/stream.ts";
import { mergeUint8Arrays } from "./serialization.ts";
import { bridge } from "./index.ts";
import { createEventEmitter } from "./eventEmitter.ts";

type DuplexItem = {
    opening: Promise<void>;
    open: boolean;
    done: boolean;
    listeners: {
        data: Set<(chunk: Uint8Array) => void>;
        close: Set<() => void>;
    };
    pendingData: Uint8Array[];
    asyncRead: {
        promise?: { resolve: () => void; reject: (reason: string) => void };
        data: Uint8Array;
    };
    queuedPackets: (ArrayBuffer | string)[];
};

const activeDuplexes = new Map<number, DuplexItem[]>();

globalThis.callback = function (id: number, payload: ArrayBuffer | string) {
    const workerStreams = (globalThis as any).__workerStreams;
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
                    type: "stream-callback",
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
        bridge({
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
};

function processPayload(
    id: number,
    duplex: DuplexItem,
    payload: ArrayBuffer | string
) {
    const chunk =
        typeof payload === "string"
            ? toByteArray(payload)
            : new Uint8Array(payload);

    duplex.done = chunk[0] === 1;
    const data = chunk.slice(1);

    if (duplex.listeners.data.size === 0 && !duplex.done) {
        duplex.pendingData.push(data);
    } else {
        duplex.listeners.data.forEach((cb) => cb(data));
    }

    if (duplex.done) {
        duplex.listeners.close.forEach((cb) => cb());
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

    if (duplex.asyncRead !== null) {
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
    on(
        event: "data",
        callback: (chunk: StreamData, encoding?: string) => void
    ): void;
    on(event: "close", callback: EndCallback): void;
    write(data: StreamData): Promise<any>;
    writeEvent(event: string, ...args: SerializableData[]): Promise<any>;
    end(
        chunk?: StreamData,
        encoding?: string | EndCallback,
        callback?: EndCallback
    ): void;
    promise(): Promise<any>;
    eventEmitter(): ReturnType<typeof createEventEmitter>;
    open(): Promise<void>;
}

const te = new TextEncoder();

export function createDuplex(id: number, bridgeFn: typeof bridge): Duplex {
    const duplex: DuplexItem = {
        opening: null,
        open: false,
        done: false,
        listeners: {
            data: new Set<(chunk: Uint8Array) => void>(),
            close: new Set<() => void>()
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
            await bridgeFn({
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

    stream.on = (event: string, cb) => {
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
        return bridgeFn({
            mod: Stream,
            fn: Write,
            data: [id, data]
        });
    };

    stream.writeEvent = async (event: string, ...args: SerializableData[]) => {
        if (!duplex.open) {
            await open();
        }
        return bridgeFn({
            mod: Stream,
            fn: WriteEvent,
            data: [id, event, ...args]
        });
    };

    stream.end = async () => {
        if (!duplex.open) {
            await open();
        }
        return bridgeFn({
            mod: Stream,
            fn: Close,
            data: [id]
        });
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

    return stream;
}
