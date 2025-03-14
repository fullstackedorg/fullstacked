import { toByteArray } from "../base64";
import { bridge } from "../bridge";
import {
    deserializeArgs,
    getLowestKeyIdAvailable,
    serializeArgs
} from "../bridge/serialization";
import core_message from "../core_message";

const te = new TextEncoder();

type ResponseSimplified = {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: string | Uint8Array | AsyncIterableIterator<string | Uint8Array>;
};

const activeFetchRequests = new Map<
    number,
    {
        resolve: (response: ResponseSimplified) => void;
        reject: (error: string) => void;
    }
>();

let addedListener = false;
function receivedResponse(base64Data: string) {
    const data = toByteArray(base64Data);
    const args = deserializeArgs(data);

    const id = args.at(0);
    const fetchRequest = activeFetchRequests.get(id);

    const [statusCode, statusMessage, headersStr, body] = args.slice(1);

    const response: ResponseSimplified = {
        statusCode,
        statusMessage,
        headers: headersStr ? JSON.parse(headersStr) : {},
        body
    };

    if (statusCode >= 400) {
        fetchRequest.reject(JSON.stringify(response));
    } else {
        fetchRequest.resolve(response);
    }

    activeFetchRequests.delete(id);
}

// 15
export default function core_fetch(
    url: string,
    options?: Partial<FetchOptions>
): Promise<FetchResponse & { body: Uint8Array }>;
export default function core_fetch(
    url: string,
    options?: Partial<FetchOptions> & { encoding: "utf8" }
): Promise<FetchResponse & { body: string }>;
export default function core_fetch(
    url: string,
    options?: Partial<FetchOptions> & { stream?: boolean, encoding?: "utf8" }
) {
    const method = options?.method || "GET";

    const headers = options?.headers ? JSON.stringify(options.headers) : "";

    const body = options?.body
        ? typeof options.body === "string"
            ? te.encode(options.body)
            : options.body
        : new Uint8Array();

    const timeout = options?.timeout || 10;

    const requestId = getLowestKeyIdAvailable(activeFetchRequests);

    const payload = new Uint8Array([
        15,

        ...serializeArgs([
            requestId,
            method,
            url,
            headers,
            body,
            timeout,
            options?.encoding === "utf8"
        ])
    ]);

    if (!addedListener) {
        core_message.addListener("fetch-response", receivedResponse);
        addedListener = true;
    }

    return new Promise<ResponseSimplified>((resolve, reject) => {
        activeFetchRequests.set(requestId, {
            resolve,
            reject
        });
        bridge(payload);
    });
}

const activeFetch2Requests = new Map<number, {
    url: string,
    resolveResponse(response: Response): void,
    resolveStream?(param: { done: boolean, chunk: Uint8Array }): void,
}>()

let addedListener2 = false;
function receivedResponse2(base64Data: string) {
    const data = toByteArray(base64Data);
    const args = deserializeArgs(data);

    const id = args.at(0);
    const request = activeFetch2Requests.get(id);

    if (request.resolveStream) {
        const [done, chunk] = args.slice(1);
        request.resolveStream({ done, chunk });
        if (done) {
            activeFetch2Requests.delete(id);
        }
        return;
    }

    const [status, statusText, headersStr] = args.slice(1);

    let finished = false;
    const read = async () => {
        if (finished) {
            return { done: true }
        }

        const { done, chunk } = await new Promise<{ done: boolean, chunk: Uint8Array }>((resolve) => {
            request.resolveStream = resolve
        });
        finished = done;

        return { done: false, value: chunk }
    }

    const responseIterator = {
        [Symbol.asyncIterator]() {
            return {
                next: read
            } as any
        }
    }

    const getReader = () => ({
        read,
        releaseLock() { }
    }) as any

    const readBody = async () => {
        let body = new Uint8Array();
        for await (const chunk of responseIterator) {
            const buffer = new Uint8Array(body.byteLength + chunk.byteLength);
            buffer.set(body, 0);
            buffer.set(chunk, body.length);
            body = buffer;
        }
        return body;
    }

    const response: Response = {
        url: request.url,
        redirected: false,
        type: "default",
        bodyUsed: false,
        ok: status <= 299,
        status,
        statusText,
        headers: objectToHeaders(JSON.parse(headersStr)),

        body: {
            getReader,
            tee() {
                return [
                    { getReader },
                    { getReader }
                ] as any
            },

            ...responseIterator,
            async cancel() {
                console.log("cancel not implemented")
            },
            locked: false,
            pipeThrough(transform, options) {
                console.log("pipeThrough not implemented")
                return null
            },
            pipeTo(destination, options) {
                console.log("pipeTo not implemented")
                return null
            },
            values(options) {
                console.log("values")
                return null
            },

        },

        bytes: readBody,
        arrayBuffer: async () => {
            const data = await readBody();
            return data.buffer;
        },
        blob: async () => {
            const body = await readBody();
            return new Blob([body])
        },
        text: async () => {
            const body = await readBody();
            return new TextDecoder().decode(body)
        },
        json: async () => {
            const body = await readBody();
            return JSON.parse(new TextDecoder().decode(body));
        },

        // not implemented
        clone: () => null,
        formData: async () => null
    }

    request.resolveResponse(response);
}

export function core_fetch2(request: Request): Promise<Response>;
export function core_fetch2(url: string | URL, options?: RequestInit): Promise<Response>;
export async function core_fetch2(
    urlOrRequest: string | URL | Request,
    options?: RequestInit
): Promise<Response> {
    if (!addedListener2) {
        core_message.addListener("fetch2-response", receivedResponse2);
        addedListener2 = true;
    }

    if (urlOrRequest instanceof Request) {
        const body = (await urlOrRequest.body.getReader().read()).value;

        options = {
            method: urlOrRequest.method,
            headers: urlOrRequest.headers,
            signal: urlOrRequest.signal,
            body: body
        }

        return fetch2(urlOrRequest.url, options)
    }

    const url = urlOrRequest instanceof URL
        ? urlOrRequest.toString()
        : urlOrRequest;

    return fetch2(url, options);
}

// 16
function fetch2(url: string, options?: RequestInit): Promise<Response> {
    const id = getLowestKeyIdAvailable(activeFetch2Requests);

    const headers = options?.headers
        ? options.headers instanceof Headers
            ? JSON.stringify(headersToObject(options.headers))
            : JSON.stringify(options.headers)
        : "";
    const body = options?.body
        ? typeof options.body === "string"
            ? te.encode(options.body)
            : options.body
        : new Uint8Array();

    if (options?.signal) {
        options.signal.onabort = () => {
            console.log("ABORT REQUEST")
            // cancel 
        }
    }

    const payload = new Uint8Array([
        16,

        ...serializeArgs([
            id,
            options?.method || "GET",
            url,
            headers,
            body
        ])
    ]);

    return new Promise<Response>((resolve) => {
        activeFetch2Requests.set(id, {
            url,
            resolveResponse: resolve
        })
        bridge(payload);
    });
}

function objectToHeaders(o: Record<string, string>) {
    const headers = new Headers();
    Object.entries(o).forEach(([n, v]) => {
        headers.set(n, v);
    });
    return headers;
};

const headersToObject = (h: Headers) => {
    const obj = {};
    for (const [n, v] of h.entries()) {
        obj[n] = v;
    }
    return obj;
};