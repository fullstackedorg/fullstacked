// nodejs source: https://nodejs.org/api/dns.html
import promises from "./promises.ts";

export * as promises from "./promises.ts";

export function lookup(hostname: string, options: any, callback?: any) {
    if (typeof options === "function") {
        callback = options;
        options = undefined;
    }

    promises
        .lookup(hostname, options)
        .then((result: any) => {
            if (Array.isArray(result)) {
                callback(null, result);
            } else {
                callback(null, result.address, result.family);
            }
        })
        .catch((err) => {
            callback(err);
        });
}

export default {
    promises,
    lookup
};
