import { bridge } from "../bridge/index.ts";
import { DeserializedData, SerializableData, Test } from "../@types/index.ts";
import { Hello, Serialization,SerializationIndex } from "../@types/test.ts";

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

function serializationIndex(index: number, ...data: SerializableData[]): DeserializedData {
    return bridge(
        {
            mod: Test,
            fn: SerializationIndex,
            data: [index].concat(data)
        },
        true
    );
}

const test = {
    hello,
    serialization,
    serializationIndex
};

export default test;
