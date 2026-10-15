import { suite } from "node:test";
import * as nodeEvents from "node:events";
import * as libEvents from "../../../core/internal/bundle/lib/events/index.ts";
import { sameFor, settle } from "../common.ts";

type EventsModule = typeof nodeEvents;
const shim = ((libEvents as any).default ?? libEvents) as EventsModule;
const node = nodeEvents.default as unknown as EventsModule;
const same = sameFor<EventsModule>("events", shim, node);

suite("shim events - EventEmitter", () => {
    same("on, once, emit order and return values", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        const log: unknown[] = [];
        ee.on("a", (x) => log.push(["on1", x]));
        ee.once("a", (x) => log.push(["once", x]));
        ee.prependListener("a", (x) => log.push(["prepend", x]));
        ee.prependOnceListener("a", (x) => log.push(["prependOnce", x]));
        log.push(ee.emit("a", 1), ee.emit("a", 2), ee.emit("b"));
        return log;
    });
    same("removeListener during emit", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        const log: string[] = [];
        const b = () => log.push("b");
        ee.on("x", () => {
            log.push("a");
            ee.removeListener("x", b);
        });
        ee.on("x", b);
        ee.emit("x");
        ee.emit("x");
        return log;
    });
    same("off removes the last added copy", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        const log: string[] = [];
        const f = () => log.push("f");
        ee.on("x", f);
        ee.on("x", () => log.push("g"));
        ee.on("x", f);
        ee.off("x", f);
        ee.emit("x");
        return [log, ee.listenerCount("x")];
    });
    same(
        "listeners, rawListeners, listenerCount, eventNames",
        ({ EventEmitter }) => {
            const ee = new EventEmitter();
            const s = Symbol("s");
            const f = () => {};
            ee.on("a", f);
            ee.once("a", f);
            ee.on(s, f);
            return [
                ee.listeners("a").length,
                ee.rawListeners("a").map((l: any) => typeof l.listener),
                ee.listenerCount("a"),
                ee.listenerCount("a", f),
                ee.eventNames()
            ];
        }
    );
    same("newListener and removeListener events", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        const log: unknown[] = [];
        ee.on("newListener", (name) => log.push(["new", name]));
        ee.on("removeListener", (name) => log.push(["remove", name]));
        const f = () => {};
        ee.on("x", f);
        ee.once("y", f);
        ee.emit("y");
        ee.off("x", f);
        ee.removeAllListeners("nothing");
        return log;
    });
    same("removeAllListeners", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        ee.on("a", () => {});
        ee.on("b", () => {});
        ee.removeAllListeners("a");
        const one = ee.eventNames();
        ee.removeAllListeners();
        return [one, ee.eventNames()];
    });
    same("error without listener throws the error", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        const error = new TypeError("boom");
        try {
            ee.emit("error", error);
        } catch (e) {
            return e === error;
        }
        return "no throw";
    });
    same("error without listener and a non-Error value", ({ EventEmitter }) =>
        new EventEmitter().emit("error", "text")
    );
    same("error without listener and no value", ({ EventEmitter }) =>
        new EventEmitter().emit("error")
    );
    same(
        "errorMonitor sees the error before it throws",
        ({ EventEmitter, errorMonitor }) => {
            const ee = new EventEmitter();
            const log: string[] = [];
            ee.on(errorMonitor, (e: Error) => log.push(e.message));
            try {
                ee.emit("error", new Error("m"));
            } catch {
                log.push("thrown");
            }
            return log;
        }
    );
    same("setMaxListeners and getMaxListeners", ({ EventEmitter }) => {
        const ee = new EventEmitter();
        const before = ee.getMaxListeners();
        ee.setMaxListeners(3);
        return [before, ee.getMaxListeners(), EventEmitter.defaultMaxListeners];
    });
    same("setMaxListeners rejects negative values", ({ EventEmitter }) =>
        new EventEmitter().setMaxListeners(-1)
    );
    same("on rejects a non-function listener", ({ EventEmitter }) =>
        new EventEmitter().on("x", "nope" as any)
    );
    same("subclass with extends", ({ EventEmitter }) => {
        class Sub extends EventEmitter {
            fire() {
                return this.emit("fire", 1);
            }
        }
        const s = new Sub();
        let got = 0;
        s.on("fire", (x) => (got = x));
        return [s.fire(), got, s instanceof EventEmitter];
    });
    same("EventEmitter.EventEmitter and the default export", (m) => [
        m.EventEmitter.EventEmitter === m.EventEmitter,
        typeof m.once,
        typeof m.on,
        typeof m.getEventListeners,
        typeof m.listenerCount,
        typeof m.setMaxListeners,
        typeof m.addAbortListener,
        typeof m.EventEmitterAsyncResource
    ]);
    same(
        "captureRejections routes a rejected listener to error",
        async ({ EventEmitter }) => {
            const ee = new EventEmitter({ captureRejections: true });
            const log: string[] = [];
            ee.on("error", (e: Error) => log.push(e.message));
            ee.on("x", async () => {
                throw new Error("rejected");
            });
            ee.emit("x");
            await settle();
            return log;
        }
    );
});

suite("shim events - helpers", () => {
    same(
        "events.once resolves with the arguments",
        async ({ EventEmitter, once }) => {
            const ee = new EventEmitter();
            const p = once(ee, "x");
            ee.emit("x", 1, 2);
            return [await p, ee.listenerCount("x"), ee.listenerCount("error")];
        }
    );
    same("events.once rejects on error", async ({ EventEmitter, once }) => {
        const ee = new EventEmitter();
        const p = once(ee, "x");
        ee.emit("error", new RangeError("e"));
        return p;
    });
    same(
        "events.once with an aborted signal",
        async ({ EventEmitter, once }) => {
            const ee = new EventEmitter();
            const controller = new AbortController();
            const p = once(ee, "x", { signal: controller.signal });
            controller.abort();
            return p;
        }
    );
    same("events.once on an EventTarget", async ({ once }) => {
        const target = new EventTarget();
        const p = once(target, "ping");
        target.dispatchEvent(new Event("ping"));
        const [event] = await p;
        return (event as Event).type;
    });
    same("events.on async iterator", async ({ EventEmitter, on }) => {
        const ee = new EventEmitter();
        const controller = new AbortController();
        const got: unknown[] = [];
        queueMicrotask(() => {
            ee.emit("x", 1);
            ee.emit("x", 2);
            controller.abort();
        });
        try {
            for await (const args of on(ee, "x", {
                signal: controller.signal
            })) {
                got.push(args);
            }
        } catch (e) {
            got.push((e as Error).name);
        }
        return got;
    });
    same("getEventListeners", ({ EventEmitter, getEventListeners }) => {
        const ee = new EventEmitter();
        ee.on("x", () => {});
        return getEventListeners(ee, "x").length;
    });
    same("listenerCount static", ({ EventEmitter, listenerCount }) => {
        const ee = new EventEmitter();
        ee.on("x", () => {});
        return listenerCount(ee, "x");
    });
});
