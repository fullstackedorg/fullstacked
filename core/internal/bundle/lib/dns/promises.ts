import { bridge } from "../bridge/index.ts";
import { Dns } from "../@types/index.ts";
import {
    Resolve4,
    Resolve6,
    ResolveCNAME,
    ResolveMX,
    ResolveNS,
    ResolveSRV,
    ResolveTXT
} from "../@types/dns.ts";

export async function resolve(hostname: string, rrtype: string) { }

export function resolve4(hostname: string, rrtype?: string): Promise<string[]> {
    return bridge({
        mod: Dns,
        fn: Resolve4,
        data: [hostname]
    });
}

export function resolve6(hostname: string, rrtype?: string): Promise<string[]> {
    return bridge({
        mod: Dns,
        fn: Resolve6,
        data: [hostname]
    });
}

export function resolveCname(hostname: string) {
    return bridge({
        mod: Dns,
        fn: ResolveCNAME,
        data: [hostname]
    });
}

export function resolveMx(hostname: string) {
    return bridge({
        mod: Dns,
        fn: ResolveMX,
        data: [hostname]
    });
}

export function resolveNs(hostname: string) {
    return bridge({
        mod: Dns,
        fn: ResolveNS,
        data: [hostname]
    });
}

export function resolveSrv(hostname: string) {
    return bridge({
        mod: Dns,
        fn: ResolveSRV,
        data: [hostname]
    });
}

export function resolveTxt(hostname: string) {
    return bridge({
        mod: Dns,
        fn: ResolveTXT,
        data: [hostname]
    });
}

export default {
    resolve4,
    resolve6,
    resolveCname,
    resolveMx,
    resolveNs,
    resolveSrv,
    resolveTxt,
};
