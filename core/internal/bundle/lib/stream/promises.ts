// node:stream/promises: pipeline and finished as promises

import { pipelineImpl } from "./pipeline.ts";
import { finished } from "./finished.ts";
import { isIterable, isNodeStream, isWebStream } from "./utils.ts";
import "./index.ts";

export function pipeline(...streams: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
        let signal: AbortSignal;
        let end: boolean;
        const lastArg = streams[streams.length - 1];
        if (
            lastArg &&
            typeof lastArg === "object" &&
            !isNodeStream(lastArg) &&
            !isIterable(lastArg) &&
            !isWebStream(lastArg)
        ) {
            const options = streams.pop();
            signal = options.signal;
            end = options.end;
        }
        pipelineImpl(
            streams,
            (err, value) => (err ? reject(err) : resolve(value)),
            { signal, end }
        );
    });
}

export { finished };

const promises = { finished, pipeline };

export default promises;
export { promises as "module.exports" };
