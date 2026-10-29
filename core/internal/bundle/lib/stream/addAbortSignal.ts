// stream.addAbortSignal (lib/internal/streams/add-abort-signal.js)

import { eos } from "./finished.ts";
import {
    ERR_INVALID_ARG_TYPE,
    abortError,
    isNodeStream,
    isWebStream,
    kControllerErrorFunction
} from "./utils.ts";

export function addAbortSignal<T>(signal: AbortSignal, stream: T): T {
    if (
        signal === null ||
        typeof signal !== "object" ||
        !("aborted" in signal)
    ) {
        throw ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
    }
    if (!isNodeStream(stream) && !isWebStream(stream)) {
        throw ERR_INVALID_ARG_TYPE(
            "stream",
            ["ReadableStream", "WritableStream", "Stream"],
            stream
        );
    }
    return addAbortSignalNoValidate(signal, stream);
}

export function addAbortSignalNoValidate<T>(signal: AbortSignal, stream: T): T {
    if (typeof signal !== "object" || !("aborted" in signal)) return stream;
    const s = stream as any;
    const onAbort = isNodeStream(s)
        ? () => s.destroy(abortError(signal))
        : () => s[kControllerErrorFunction]?.(abortError(signal));
    if (signal.aborted) {
        onAbort();
    } else {
        signal.addEventListener("abort", onAbort, { once: true });
        eos(s, () => signal.removeEventListener("abort", onAbort));
    }
    return stream;
}
