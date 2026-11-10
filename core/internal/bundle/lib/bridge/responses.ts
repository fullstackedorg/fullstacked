import { shared } from "./shared.ts";

// Responses of message calls that the host put on the frame stream (large
// responses, see router.CallForMessage). The frame and the empty message
// reply travel on different channels: either can arrive first. The ids are
// the page's, so are the responses (see shared.ts).

function createResponses() {
    const waiting = new Map<number, (response: ArrayBuffer) => void>();
    const arrived = new Map<number, ArrayBuffer>();

    function onResponseFrame(id: number, data: Uint8Array) {
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

    function responseFrame(id: number): Promise<ArrayBuffer> {
        const response = arrived.get(id);
        if (response) {
            arrived.delete(id);
            return Promise.resolve(response);
        }
        return new Promise((resolve) => waiting.set(id, resolve));
    }

    return { onResponseFrame, responseFrame };
}

const responses = shared("responses", createResponses);

export const onResponseFrame = responses.onResponseFrame;
export const responseFrame = responses.responseFrame;
