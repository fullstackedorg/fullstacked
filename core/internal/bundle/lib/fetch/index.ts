import { Fetch } from "../@types/index.ts";
import {
    Cancel,
    Fetch as FetchFn,
    RequestHead,
    ResponseBody,
    ResponseHead
} from "../@types/fetch.ts";
import { bridge } from "../bridge/index.ts";
import { mergeUint8Arrays } from "../bridge/serialization.ts";
import { Duplex } from "../bridge/duplex.ts";
import { EventEmitter } from "../bridge/eventEmitter.ts";

function headersToObj(headers: HeadersInit) {
    if (headers === null) return {};
    return Object.fromEntries(new Headers(headers).entries());
}
function objToHeader(headersObj: ResponseHead["Headers"]) {
    const headers = new Headers();
    if (!headersObj) return headers;
    Object.entries(headersObj).forEach(([key, values]) =>
        headers.set(key.toLowerCase(), values.at(-1))
    );
    return headers;
}

function bodyInitToBuffer(body: BodyInit) {
    if (!body) return null;
    return new Response(body).arrayBuffer();
}

function urlOrStringToUrl(url: URL | string) {
    return url instanceof URL
        ? url
        : new URL(
              url,
              url.startsWith("/") ? globalThis?.location?.host : undefined
          );
}

async function fetchCore(
    request: string | URL | Request,
    init?: RequestInit
): Promise<Response> {
    const signal = init?.signal;
    if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }

    const url = (
        request instanceof URL || typeof request === "string"
            ? urlOrStringToUrl(request)
            : urlOrStringToUrl(request.url)
    ).toString();

    const method =
        (request instanceof Request ? request.method : init?.method) || "GET";
    const headers = headersToObj(
        (request instanceof Request ? request.headers : init?.headers) || null
    );

    const requestHead: RequestHead = {
        Url: url,
        Method: method,
        Headers: headers
    };

    const requestBody =
        request instanceof Request
            ? await request.arrayBuffer()
            : await bodyInitToBuffer(init?.body);

    let responseHeadEE: EventEmitter<{
            response: [ResponseHead];
            error: [string];
        }>,
        responseHead: ResponseHead,
        responseBodyStream: Duplex;

    let rejectHead: (reason?: any) => void;

    const onAbort = () => {
        const error = new DOMException(
            "The operation was aborted.",
            "AbortError"
        );

        rejectHead?.(error);

        responseHeadEE?.duplex.end();

        responseBodyStream?.end();

        if (responseHead) {
            bridge({
                mod: Fetch,
                fn: Cancel,
                data: [responseHead.Id]
            });
        }
    };

    if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
        responseHead = await new Promise(async (resolve, reject) => {
            rejectHead = reject;
            responseHeadEE = (
                (await bridge({
                    mod: Fetch,
                    fn: FetchFn,
                    data: [requestHead, new Uint8Array(requestBody)]
                })) as Duplex
            ).eventEmitter();

            responseHeadEE.on("response", (responseHead) => {
                resolve(responseHead);
            });

            responseHeadEE.on("error", (error) => {
                reject(error);
            });

            responseHeadEE.duplex.on("close", () => {
                responseHeadEE = null;
            });
        });

        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        responseBodyStream = await bridge({
            mod: Fetch,
            fn: ResponseBody,
            data: [responseHead.Id]
        });

        responseBodyStream.on("close", () => {
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
        });
    } catch (e) {
        if (signal) {
            signal.removeEventListener("abort", onAbort);
        }
        throw e;
    }

    const readBody = async () => {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        try {
            let buffer = new Uint8Array();
            for await (const chunk of responseBodyStream) {
                if (signal?.aborted) {
                    throw new DOMException(
                        "The operation was aborted.",
                        "AbortError"
                    );
                }
                buffer = mergeUint8Arrays(buffer, chunk);
            }
            return buffer;
        } finally {
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
        }
    };

    const response: Response = {
        url,
        redirected: false,
        headers: objToHeader(responseHead.Headers),
        type: "default",
        ok: responseHead.Status >= 200 && responseHead.Status <= 299,
        status: responseHead.Status,
        statusText: responseHead.StatusText.replace(
            responseHead.Status.toString(),
            ""
        ).trim(),
        bodyUsed: false,
        body: responseBodyStream,
        json: async () => {
            return JSON.parse(new TextDecoder().decode(await readBody()));
        },
        text: async () => {
            return new TextDecoder().decode(await readBody());
        },
        arrayBuffer: async () => {
            return (await readBody()).buffer;
        },
        blob: async () => {
            return new Blob([await readBody()]);
        },
        bytes: readBody,

        // not implemented
        clone: () => null as Response,
        formData: async () => null as FormData
    };

    return response;
}

globalThis.originalFetch = fetch;
globalThis.fetch = fetchCore;
