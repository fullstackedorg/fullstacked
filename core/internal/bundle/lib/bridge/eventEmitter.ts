import type { Duplex } from "./duplex.ts";
import {
    deserializeAll,
    mergeUint8Arrays,
    uint4BytesToNumber
} from "./serialization.ts";

export type EventEmitter<K extends Record<string, any[]>> = {
    duplex: Duplex;
    on(event: keyof K, callback: (...args: K[keyof K]) => void): void;
    off(event: keyof K, callback: (...args: K[keyof K]) => void): void;
    writeEvent(event: keyof K, ...args: K[keyof K]): void;
};

export function createEventEmitter<K extends Record<string, any[]>>(
    duplex: Duplex
): EventEmitter<K> {
    const eventListeners = new Map<
        keyof K,
        Set<(...args: K[keyof K]) => void>
    >();

    const processEvent = (buffer: Uint8Array<ArrayBuffer>) => {
        const [name, ...data] = deserializeAll(buffer.buffer);
        const listeners = eventListeners.get(name);
        listeners?.forEach((cb) => cb(...(data as K[keyof K])));
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

        accumulator = accumulator.slice(cursor);
        processAccumulator();
    };

    duplex.on("data", (chunk) => {
        accumulator = mergeUint8Arrays(
            accumulator,
            new Uint8Array(chunk as Buffer)
        );
        processAccumulator();
    });

    return {
        duplex,
        on(event: keyof K, callback: (...args: K[keyof K]) => void) {
            let listeners = eventListeners.get(event);
            if (!listeners) {
                listeners = new Set();
                eventListeners.set(event, listeners);
            }
            listeners.add(callback);
        },
        off(event: keyof K, callback: (...args: K[keyof K]) => void) {
            let listeners = eventListeners.get(event);
            listeners?.delete(callback);
        },
        writeEvent(event: keyof K, ...args: K[keyof K]) {
            duplex.writeEvent(event as string, ...args);
        }
    };
}
