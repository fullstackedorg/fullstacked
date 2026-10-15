import { suite } from "node:test";
import * as nodeDc from "node:diagnostics_channel";
import * as libDc from "../../../core/internal/bundle/lib/diagnostics_channel/index.ts";
import { sameFor, settle } from "../common.ts";

type DcModule = typeof nodeDc;
const shim = libDc as unknown as DcModule;
let n = 0;
// channel names are global per implementation: a fresh one per case
const fresh = () => `shim-test-${process.pid}-${n++}`;
const same = sameFor<DcModule>("diagnostics_channel", shim, nodeDc);

suite("shim diagnostics_channel", () => {
    same("channel identity, name and hasSubscribers", (dc) => {
        const name = fresh();
        const a = dc.channel(name);
        const before = [a.hasSubscribers, dc.hasSubscribers(name)];
        const fn = () => {};
        a.subscribe(fn);
        const during = [a.hasSubscribers, dc.hasSubscribers(name)];
        a.unsubscribe(fn);
        return [
            a === dc.channel(name),
            a.name === name,
            before,
            during,
            a.hasSubscribers
        ];
    });
    same("publish reaches subscribers in order with the name", (dc) => {
        const name = fresh();
        const log: unknown[] = [];
        const ch = dc.channel(name);
        ch.subscribe((message, n) => log.push(["a", message, n === name]));
        dc.subscribe(name, (message) => log.push(["b", message]));
        ch.publish({ x: 1 });
        return log;
    });
    same("unsubscribe returns whether it removed", (dc) => {
        const name = fresh();
        const fn = () => {};
        dc.subscribe(name, fn);
        return [dc.unsubscribe(name, fn), dc.unsubscribe(name, fn)];
    });
    same("a throwing subscriber does not stop the others", async (dc) => {
        const name = fresh();
        const log: string[] = [];
        const ch = dc.channel(name);
        // the error is rethrown as uncaught: captured here, or node:test
        // would fail the case itself
        process.setUncaughtExceptionCaptureCallback((e) => {
            log.push(`uncaught ${(e as Error).message}`);
        });
        try {
            ch.subscribe(() => {
                throw new Error("boom");
            });
            ch.subscribe(() => log.push("second"));
            ch.publish(1);
            await settle();
        } finally {
            process.setUncaughtExceptionCaptureCallback(null);
        }
        return log;
    });
    same("symbol channel names", (dc) => {
        const name = Symbol("dc");
        const ch = dc.channel(name);
        return [ch.name === name, ch === dc.channel(name)];
    });
    same("tracingChannel traceSync", (dc) => {
        const tc = dc.tracingChannel(fresh());
        const log: string[] = [];
        tc.subscribe({
            start: (m: any) => log.push(`start ${m.arg}`),
            end: (m: any) => log.push(`end ${m.result}`),
            asyncStart: () => log.push("asyncStart"),
            asyncEnd: () => log.push("asyncEnd"),
            error: (m: any) => log.push(`error ${m.error.message}`)
        });
        const r = tc.traceSync(
            (x: number) => x * 2,
            { arg: 2 } as any,
            null,
            2
        );
        try {
            tc.traceSync(
                () => {
                    throw new Error("bad");
                },
                { arg: 0 } as any
            );
        } catch {}
        return [r, log, tc.hasSubscribers];
    });
    same("tracingChannel tracePromise", async (dc) => {
        const tc = dc.tracingChannel(fresh());
        const log: string[] = [];
        tc.subscribe({
            start: () => log.push("start"),
            end: () => log.push("end"),
            asyncStart: (m: any) => log.push(`asyncStart ${m.result}`),
            asyncEnd: () => log.push("asyncEnd"),
            error: () => log.push("error")
        });
        const r = await tc.tracePromise(async () => 7, {} as any);
        return [r, log];
    });
    same("tracingChannel traceCallback", async (dc) => {
        const tc = dc.tracingChannel(fresh());
        const log: string[] = [];
        tc.subscribe({
            start: () => log.push("start"),
            end: () => log.push("end"),
            asyncStart: () => log.push("asyncStart"),
            asyncEnd: () => log.push("asyncEnd"),
            error: () => log.push("error")
        });
        const value = await new Promise((resolve) =>
            tc.traceCallback(
                (cb: (e: null, v: number) => void) =>
                    queueMicrotask(() => cb(null, 3)),
                0,
                {} as any,
                null,
                (_e: unknown, v: number) => resolve(v)
            )
        );
        return [value, log];
    });
    same("exports", (dc) =>
        [
            "channel",
            "hasSubscribers",
            "subscribe",
            "unsubscribe",
            "tracingChannel",
            "Channel"
        ].map((k) => [k, typeof (dc as any)[k]])
    );
});
