import { toByteArray } from "./base64.ts";
import { Stream } from "../@types/index.ts";
import { Close, Open, Write } from "../@types/stream.ts";
import { mergeUint8Arrays } from "./serialization.ts";
import type { bridge } from "./index.ts";

type DuplexItem = {
    opening: Promise<void>;
    open: boolean;
    done: boolean;
    listeners: {
        data: Set<(chunk: Uint8Array) => void>;
        close: Set<() => void>;
    };
    asyncRead: {
        promise?: { resolve: () => void; reject: (reason: string) => void };
        data: Uint8Array;
    };
};

const activeDuplexes = new Map<number, DuplexItem>();

globalThis.callback = async function (
    id: number,
    payload: ArrayBuffer | string
) {
    const chunk =
        typeof payload === "string"
            ? toByteArray(payload)
            : new Uint8Array(payload);

    const duplex = activeDuplexes.get(id);

    if (duplex.opening) {
        await duplex.opening;
    }

    duplex.done = chunk[0] === 1;
    const data = chunk.slice(1);

    duplex?.listeners.data.forEach((cb) => cb(data));
    if (duplex.done) duplex?.listeners.close.forEach((cb) => cb());

    if (duplex?.asyncRead === null) {
        return;
    }

    duplex.asyncRead.data =
        duplex.asyncRead.data === null
            ? data
            : mergeUint8Arrays(duplex.asyncRead.data, data);

    duplex?.asyncRead?.promise?.resolve?.();
};

type StreamData = string | Buffer | Uint8Array | DataView;

type EndCallback = () => void;

export interface Duplex extends ReadableStream<Uint8Array> {
    on(
        event: "data",
        callback: (chunk: StreamData, encoding?: string) => void
    ): void;
    on(event: "close", callback: EndCallback): void;
    write(data: StreamData): void;
    end(
        chunk?: StreamData,
        encoding?: string | EndCallback,
        callback?: EndCallback
    ): void;
}

export function createDuplex(id: number, bridgeFn: typeof bridge): Duplex {
    const duplex: DuplexItem = {
        opening: null,
        open: false,
        done: false,
        listeners: {
            data: new Set<(chunk: Uint8Array) => void>(),
            close: new Set<() => void>()
        },
        asyncRead: null
    };

    activeDuplexes.set(id, duplex);

    const open = () => {
        if (duplex.open) {
            throw "trying to open a duplex already opened";
        }

        if (duplex.opening) {
            throw "trying to open a duplex opening";
        }

        duplex.opening = new Promise(async (resolveOpening) => {
            await bridgeFn({
                mod: Stream,
                fn: Open,
                data: [id]
            });

            duplex.open = true;
            resolveOpening();
            duplex.opening = null;
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
            duplex.asyncRead = {
                data: null
            };
        }

        if (!duplex.open) {
            await open();
        }

        if (!duplex.asyncRead.data) {
            await read();
        }

        const value = duplex.asyncRead.data;
        duplex.asyncRead.data = null;

        return {
            value,
            done: duplex.done
        };
    };

    const it = {
        next
    };

    const stream = iteratorToStream(it as AsyncIterator<Uint8Array>);

    stream.on = (event: string, cb) => {
        switch (event) {
            case "data":
                duplex.listeners.data.add(cb);
                break;
            case "close":
                duplex.listeners.close.add(cb);
                break;
        }

        if (!duplex.open && duplex.opening === null) {
            open();
        }
    };

    stream.write = (data: Uint8Array) =>
        bridgeFn({
            mod: Stream,
            fn: Write,
            data: [id, data]
        });

    stream.end = () =>
        bridgeFn({
            mod: Stream,
            fn: Close,
            data: [id]
        });

    return stream;
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
    }) as any;
}
