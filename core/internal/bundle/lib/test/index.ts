import { bridge } from "../bridge/index.ts";
import { DeserializedData, SerializableData, Test } from "../@types/index.ts";
import {
    EventEmitter as EventEmitterFn,
    Hello,
    Serialization,
    SerializationIndex,
    Stream,
    StreamWrite
} from "../@types/test.ts";
import { Duplex } from "../bridge/duplex.ts";
import { EventEmitter } from "../bridge/eventEmitter.ts";

function hello(): string {
    return bridge(
        {
            mod: Test,
            fn: Hello
        },
        true
    );
}

function serialization(data: SerializableData): DeserializedData {
    return bridge(
        {
            mod: Test,
            fn: Serialization,
            data: [data]
        },
        true
    );
}

function serializationIndex(
    index: number,
    ...data: SerializableData[]
): DeserializedData {
    return bridge(
        {
            mod: Test,
            fn: SerializationIndex,
            data: [index].concat(data)
        },
        true
    );
}

function streaming(data: Uint8Array, intervalMs: number, async: false): Duplex;
function streaming(
    data: Uint8Array,
    intervalMs: number,
    async: true
): Promise<Duplex>;
function streaming(data: Uint8Array, intervalMs: number, async: boolean) {
    return bridge(
        {
            mod: Test,
            fn: Stream,
            data: [data, intervalMs, async]
        },
        !async
    );
}

function streamWrite(async: false): Duplex;
function streamWrite(async: true): Promise<Duplex>;
function streamWrite(async: boolean) {
    return bridge(
        {
            mod: Test,
            fn: StreamWrite,
            data: []
        },
        !async
    );
}

function eventEmitter(
    delay: number,
    ...data: SerializableData[]
): EventEmitter<{
    event: [any];
}> {
    return (
        bridge(
            {
                mod: Test,
                fn: EventEmitterFn,
                data: [delay, ...data]
            },
            true
        ) as Duplex
    ).eventEmitter();
}

const test = {
    hello,
    serialization,
    serializationIndex,
    streaming,
    streamWrite,
    eventEmitter
};

export default test;
