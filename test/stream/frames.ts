import test, { suite } from "node:test";
import assert from "node:assert";
import { FrameParser } from "../../core/internal/bundle/lib/bridge/frames.ts";

function frame(streamId: number, flags: number, data: number[]) {
    const bytes = new Uint8Array(9 + data.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, streamId);
    bytes[4] = flags;
    view.setUint32(5, data.length);
    bytes.set(data, 9);
    return bytes;
}

function concat(...arrays: Uint8Array[]) {
    const out = new Uint8Array(arrays.reduce((s, a) => s + a.byteLength, 0));
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.byteLength;
    }
    return out;
}

function parseIn(stream: Uint8Array, cuts: number[]) {
    const frames: [number, number, number[], number][] = [];
    const parser = new FrameParser((streamId, flags, data) => {
        frames.push([
            streamId,
            flags,
            Array.from(data),
            data.buffer.byteLength
        ]);
    });
    let start = 0;
    for (const cut of [...cuts, stream.byteLength]) {
        parser.push(stream.subarray(start, cut));
        start = cut;
    }
    return frames;
}

suite("stream - frames", () => {
    const stream = concat(
        frame(0, 0, []),
        frame(3, 0, [1, 2, 3, 4, 5]),
        frame(4, 2, [101, 114, 114]),
        frame(3, 1, []),
        // ids past one byte, a context holds more than 255 streams
        frame(300, 0, [7]),
        frame(70000, 1, [8, 9])
    );
    const expected = [
        [0, 0, [], 0],
        [3, 0, [1, 2, 3, 4, 5], 5],
        [4, 2, [101, 114, 114], 3],
        [3, 1, [], 0],
        [300, 0, [7], 1],
        [70000, 1, [8, 9], 2]
    ];

    test("whole frames in one chunk", () => {
        assert.deepEqual(parseIn(stream, []), expected);
    });

    test("frames cut at every byte", () => {
        const cuts = Array.from(
            { length: stream.byteLength - 1 },
            (_, i) => i + 1
        );
        assert.deepEqual(parseIn(stream, cuts), expected);
    });

    test("frames cut in headers and data", () => {
        assert.deepEqual(parseIn(stream, [3, 8, 9, 20, 25, 40, 50]), expected);
    });
});
