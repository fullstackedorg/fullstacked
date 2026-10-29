// node:stream/consumers: a whole stream (Readable, web ReadableStream or
// async iterable) as text, JSON, bytes or a Blob

import { Buffer } from "../buffer/index.ts";
import { iterableOf } from "./utils.ts";

type Source = AsyncIterable<any> | ReadableStream | NodeJS.ReadableStream;

export async function blob(stream: Source): Promise<Blob> {
    const chunks: any[] = [];
    for await (const chunk of iterableOf(stream)) chunks.push(chunk);
    return new Blob(chunks);
}

export async function arrayBuffer(stream: Source): Promise<ArrayBuffer> {
    return (await blob(stream)).arrayBuffer();
}

export async function buffer(stream: Source): Promise<Buffer> {
    return Buffer.from(await arrayBuffer(stream));
}

export async function bytes(stream: Source): Promise<Uint8Array> {
    return new Uint8Array(await arrayBuffer(stream));
}

export async function text(stream: Source): Promise<string> {
    const decoder = new TextDecoder();
    let str = "";
    for await (const chunk of iterableOf(stream)) {
        if (typeof chunk === "string") str += chunk;
        else str += decoder.decode(chunk, { stream: true });
    }
    str += decoder.decode(undefined, { stream: false });
    return str;
}

export async function json(stream: Source): Promise<any> {
    return JSON.parse(await text(stream));
}

const consumers = { arrayBuffer, blob, buffer, bytes, text, json };

export default consumers;
export { consumers as "module.exports" };
