import { Fetch } from "../@types/index.ts";
import {
    Fetch as FetchFn,
    RequestHead,
    ResponseBody,
    ResponseHead
} from "../@types/fetch.ts";
import { bridge } from "../bridge/index.ts";
import { mergeUint8Arrays } from "../bridge/serialization.ts";

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
    return url instanceof URL ? url : new URL(url, globalThis?.location?.host);
}

async function fetchCore(
    request: string | URL | Request,
    init?: RequestInit
): Promise<Response> {
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

    const responseHead: ResponseHead = await bridge({
        mod: Fetch,
        fn: FetchFn,
        data: [requestHead, new Uint8Array(requestBody)]
    });

    const responseBodyStream = await bridge({
        mod: Fetch,
        fn: ResponseBody,
        data: [responseHead.Id]
    });

    const readBody = async () => {
        let buffer = new Uint8Array();
        for await (const chunk of responseBodyStream) {
            buffer = mergeUint8Arrays(buffer, chunk);
        }
        return buffer;
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
