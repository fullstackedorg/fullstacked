import { bridge } from "../bridge/index.ts";
import { DeserializedData, SerializableData, Test } from "../@types/index.ts";
import {
    Hello,
    Serialization,
    SerializationIndex,
    Stream
} from "../@types/test.ts";

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

function streaming(data: Uint8Array, intervalMs: number, async: false): ReadableStream<Uint8Array>
function streaming(data: Uint8Array, intervalMs: number, async: true): Promise<ReadableStream<Uint8Array>>
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

const test = {
    hello,
    serialization,
    serializationIndex,
    streaming
};

export default test;
