// Responses of message calls that the host put on the frame stream (large
// responses, see router.CallForMessage). The frame and the empty message
// reply travel on different channels: either can arrive first.

const waiting = new Map<number, (response: ArrayBuffer) => void>();
const arrived = new Map<number, ArrayBuffer>();

export function onResponseFrame(id: number, data: Uint8Array) {
    const response =
        data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
            ? (data.buffer as ArrayBuffer)
            : data.slice().buffer;
    const resolve = waiting.get(id);
    if (resolve) {
        waiting.delete(id);
        resolve(response);
    } else {
        arrived.set(id, response);
    }
}

export function responseFrame(id: number): Promise<ArrayBuffer> {
    const response = arrived.get(id);
    if (response) {
        arrived.delete(id);
        return Promise.resolve(response);
    }
    return new Promise((resolve) => waiting.set(id, resolve));
}
