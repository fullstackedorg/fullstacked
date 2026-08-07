import { Dns } from "../@types/index.ts";
import {
    Resolve4,
    Resolve6,
    ResolveCNAME,
    ResolveMX,
    ResolveNS,
    ResolveSRV,
    ResolveTXT,
    Lookup,
    LookupResult
} from "../@types/dns.ts";

export async function resolve(hostname: string, rrtype: string) { }

export function resolve4(hostname: string, rrtype?: string): Promise<string[]> {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: Resolve4,
        data: [hostname]
    });
}

export function resolve6(hostname: string, rrtype?: string): Promise<string[]> {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: Resolve6,
        data: [hostname]
    });
}

export function resolveCname(hostname: string) {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: ResolveCNAME,
        data: [hostname]
    });
}

export function resolveMx(hostname: string) {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: ResolveMX,
        data: [hostname]
    });
}

export function resolveNs(hostname: string) {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: ResolveNS,
        data: [hostname]
    });
}

export function resolveSrv(hostname: string) {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: ResolveSRV,
        data: [hostname]
    });
}

export function resolveTxt(hostname: string) {
    return globalThis.fullstacked.bridge({
        mod: Dns,
        fn: ResolveTXT,
        data: [hostname]
    });
}

export async function lookup(hostname: string, options?: any) {
    let family = 0;
    let all = false;

    if (typeof options === "number") {
        family = options;
    } else if (typeof options === "object" && options !== null) {
        family = options.family || 0;
        all = options.all || false;
    }

    const results: LookupResult[] = await globalThis.fullstacked.bridge({
        mod: Dns,
        fn: Lookup,
        data: [hostname]
    });

    const filtered = (results || []).filter((r) => family === 0 || r.family === family);

    if (filtered.length === 0) {
        throw new Error(`ENOTFOUND ${hostname}`);
    }

    if (all) {
        return filtered;
    }

    return filtered[0];
}

export default {
    resolve4,
    resolve6,
    resolveCname,
    resolveMx,
    resolveNs,
    resolveSrv,
    resolveTxt,
    lookup
};
