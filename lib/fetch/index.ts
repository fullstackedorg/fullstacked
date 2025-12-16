import { Fetch } from "../@types/index.ts";
import {
    Fetch as FetchFn,
    RequestHead,
    ResponseHead
} from "../@types/fetch.ts";
import { bridge } from "../bridge/index.ts";

function headersToObj(headers: HeadersInit) {
    if (headers === null) return {};
    return Object.fromEntries(new Headers(headers).entries());
}
function objToHeader(headersObj: ResponseHead["Headers"]) {
    const headers = new Headers();
    if(!headersObj) return headers;
    Object.entries(headersObj).forEach(([key, values]) => headers.set(key.toLowerCase(), values.at(-1)))
    return headers;
}

function bodyInitToBuffer(body: BodyInit) {
    if (!body) return null;
    return new Response(body).arrayBuffer();
}

export async function fetch(
    request: string | URL | Request,
    init?: RequestInit
): Promise<Response> {
    const url = (
        request instanceof URL || typeof request === "string"
            ? request
            : request.url
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
        data: [requestHead, requestBody]
    });

    const response: Response = {
        url,
        redirected: false,
        headers: objToHeader(responseHead.Headers),
        type: "default",
        ok: responseHead.Status >= 200 && responseHead.Status <= 299,
        status: responseHead.Status,
        statusText: responseHead.StatusText,
        bodyUsed: false,
        body: null,
        clone: () => null,
        json: () => null,
        text: () => null,
        arrayBuffer: () => null,
        blob: () => null,
        bytes: () => null,
        formData: () => null
    };

    return response;
}
