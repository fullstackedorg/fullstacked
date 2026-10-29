// node:stream/web: the engine's web streams (Node's are its own
// implementation of the same WHATWG classes). A class the engine lacks is
// undefined.

const g = globalThis as any;

export const ReadableStream = g.ReadableStream;
export const ReadableStreamDefaultReader = g.ReadableStreamDefaultReader;
export const ReadableStreamBYOBReader = g.ReadableStreamBYOBReader;
export const ReadableStreamBYOBRequest = g.ReadableStreamBYOBRequest;
export const ReadableByteStreamController = g.ReadableByteStreamController;
export const ReadableStreamDefaultController =
    g.ReadableStreamDefaultController;
export const TransformStream = g.TransformStream;
export const TransformStreamDefaultController =
    g.TransformStreamDefaultController;
export const WritableStream = g.WritableStream;
export const WritableStreamDefaultWriter = g.WritableStreamDefaultWriter;
export const WritableStreamDefaultController =
    g.WritableStreamDefaultController;
export const ByteLengthQueuingStrategy = g.ByteLengthQueuingStrategy;
export const CountQueuingStrategy = g.CountQueuingStrategy;
export const TextEncoderStream = g.TextEncoderStream;
export const TextDecoderStream = g.TextDecoderStream;
export const CompressionStream = g.CompressionStream;
export const DecompressionStream = g.DecompressionStream;

const web = {
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamBYOBRequest,
    ReadableByteStreamController,
    ReadableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream
};

export default web;
export { web as "module.exports" };
