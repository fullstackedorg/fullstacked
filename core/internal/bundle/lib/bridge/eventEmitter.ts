import type { Duplex } from "./duplex.ts";
import {
    deserializeAll,
    mergeUint8Arrays,
    uint4BytesToNumber
} from "./serialization.ts";

export type EventEmitter<K extends Record<string, any[]>> = {
    duplex: Duplex;
    on<E extends keyof K>(event: E, callback: (...args: K[E]) => void): void;
    off<E extends keyof K>(event: E, callback: (...args: K[E]) => void): void;
    writeEvent<E extends keyof K>(event: E, ...args: K[E]): void;
};

export function createEventEmitter<K extends Record<string, any[]>>(
    duplex: Duplex
): EventEmitter<K> {
    const eventListeners = new Map<keyof K, Set<(...args: any[]) => void>>();

    const processEvent = (buffer: Uint8Array<ArrayBuffer>) => {
        const [name, ...data] = deserializeAll(buffer.buffer);
        const listeners = eventListeners.get(name);
        listeners?.forEach((cb) => cb(...(data as any[])));
    };

    let sizeNeeded = -1;
    let accumulator = new Uint8Array();

    const processAccumulator = () => {
        if (accumulator.byteLength < 4) {
            return;
        }

        let cursor = 0;

        if (sizeNeeded === -1) {
            sizeNeeded = uint4BytesToNumber(
                accumulator.slice(cursor, cursor + 4)
            );
            cursor += 4;
        }

        if (cursor + sizeNeeded <= accumulator.byteLength) {
            processEvent(accumulator.slice(cursor, cursor + sizeNeeded));
            cursor += sizeNeeded;
            sizeNeeded = -1;
        }

        if (cursor != 0) {
            accumulator = accumulator.slice(cursor);
            processAccumulator();
        }
    };

    duplex.on("data", (chunk) => {
        const uint8Array = new Uint8Array(chunk as Buffer);
        accumulator = mergeUint8Arrays(accumulator, uint8Array);
        processAccumulator();
    });

    return {
        duplex,
        on<E extends keyof K>(event: E, callback: (...args: K[E]) => void) {
            let listeners = eventListeners.get(event);
            if (!listeners) {
                listeners = new Set();
                eventListeners.set(event, listeners);
            }
            listeners.add(callback as (...args: any[]) => void);
        },
        off<E extends keyof K>(event: E, callback: (...args: K[E]) => void) {
            let listeners = eventListeners.get(event);
            listeners?.delete(callback as (...args: any[]) => void);
        },
        writeEvent<E extends keyof K>(event: E, ...args: K[E]) {
            duplex.writeEvent(event as string, ...args);
        }
    };
}
