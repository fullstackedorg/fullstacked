import { suite } from "node:test";
import * as nodeStream from "node:stream";
import * as libStream from "../../../core/internal/bundle/lib/stream/index.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import { sameFor, settle } from "../common.ts";
import * as libPromises from "../../../core/internal/bundle/lib/stream/promises.ts";
import * as libConsumers from "../../../core/internal/bundle/lib/stream/consumers.ts";
import * as libWeb from "../../../core/internal/bundle/lib/stream/web.ts";
import * as nodePromises from "node:stream/promises";
import * as nodeConsumers from "node:stream/consumers";
import * as nodeWeb from "node:stream/web";
import { inherits } from "node:util";

// Each scenario returns the log of what happened, in order, once the loop
// is quiet: the same scenario on node:stream gives the reference log.

type StreamModule = typeof nodeStream;
type Env = { stream: StreamModule; Buffer: typeof Buffer };
const shimStream = ((libStream as any).default ?? libStream) as StreamModule;
const shim: Env = { stream: shimStream, Buffer: (libBuffer as any).Buffer };
const node: Env = {
    stream: nodeStream.default as unknown as StreamModule,
    Buffer
};
const same = sameFor<Env>("stream", shim, node);

const str = (chunk: unknown) =>
    typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? `<${Buffer.from(chunk).toString()}>`
          : JSON.stringify(chunk);

function track(emitter: any, log: unknown[], name: string, events: string[]) {
    for (const event of events) {
        emitter.on(event, (arg: unknown) =>
            log.push(
                `${name}:${event}${arg === undefined ? "" : ` ${arg instanceof Error ? arg.message : str(arg)}`}`
            )
        );
    }
}

suite("shim stream - Readable", () => {
    same("push, data, end, close order", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        track(r, log, "r", ["data", "end", "close"]);
        r.push("a");
        r.push("b");
        r.push(null);
        await settle();
        return log;
    });
    same("paused mode with 'readable' and read(n)", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.on("readable", () => {
            let chunk;
            while ((chunk = r.read(2)) !== null) log.push(`read ${str(chunk)}`);
            log.push("readable done");
        });
        r.on("end", () => log.push("end"));
        r.push("abcde");
        r.push(null);
        await settle();
        return log;
    });
    same("read() drains then end", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.push("xy");
        r.push(null);
        r.on("end", () => log.push("end"));
        log.push(str(r.read()));
        log.push(r.read());
        await settle();
        return log;
    });
    same("objectMode", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ objectMode: true, read() {} });
        track(r, log, "r", ["data", "end"]);
        r.push({ a: 1 });
        r.push(0);
        r.push("s");
        r.push(null);
        await settle();
        return log;
    });
    same("highWaterMark and push return values", ({ stream }) => {
        const r = new stream.Readable({ highWaterMark: 4, read() {} });
        return [
            r.push("ab"),
            r.push("cd"),
            r.push("ef"),
            r.readableLength,
            r.readableHighWaterMark
        ];
    });
    same(
        "setEncoding splits no multibyte character",
        async ({ stream, Buffer }) => {
            const log: unknown[] = [];
            const r = new stream.Readable({ read() {} });
            r.setEncoding("utf8");
            r.on("data", (d) => log.push(d));
            const bytes = Buffer.from("é€😀");
            for (let i = 0; i < bytes.length; i++)
                r.push(bytes.subarray(i, i + 1));
            r.push(null);
            await settle();
            return log.join("|");
        }
    );
    same("unshift", async ({ stream }) => {
        const r = new stream.Readable({ read() {} });
        r.push("world");
        r.unshift("hello ");
        r.push(null);
        const chunks: string[] = [];
        for await (const c of r) chunks.push(str(c));
        return chunks.join("");
    });
    same("pause and resume", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.on("data", (d) => {
            log.push(str(d));
            r.pause();
            log.push(`paused ${r.isPaused()}`);
            setTimeout(() => r.resume(), 1);
        });
        r.push("a");
        r.push("b");
        r.push(null);
        await settle(30);
        return log;
    });
    same("destroy(err) emits error then close", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        track(r, log, "r", ["error", "close", "end"]);
        r.destroy(new Error("boom"));
        log.push(`destroyed ${r.destroyed}`);
        await settle();
        return [log, r.errored instanceof Error];
    });
    same("_destroy callback", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({
            read() {},
            destroy(err, cb) {
                log.push(`_destroy ${err?.message}`);
                cb(new Error("from destroy"));
            }
        });
        track(r, log, "r", ["error", "close"]);
        r.destroy(new Error("first"));
        await settle();
        return log;
    });
    same(
        "Readable.from array, string and async generator",
        async ({ stream }) => {
            const collect = async (r: AsyncIterable<unknown>) => {
                const out: unknown[] = [];
                for await (const c of r) out.push(str(c));
                return out;
            };
            async function* gen() {
                yield "x";
                yield "y";
            }
            return [
                await collect(stream.Readable.from([1, 2, 3])),
                await collect(stream.Readable.from("whole")),
                await collect(stream.Readable.from(gen()))
            ];
        }
    );
    same("async iterator stops on break and destroys", async ({ stream }) => {
        const r = stream.Readable.from([1, 2, 3]);
        for await (const _ of r) break;
        await settle();
        return r.destroyed;
    });
    same("toArray, map, filter helpers", async ({ stream }) => [
        await (stream.Readable.from([1, 2, 3]) as any).toArray(),
        await (stream.Readable.from([1, 2, 3]) as any)
            .map((x: number) => x * 2)
            .toArray(),
        await (stream.Readable.from([1, 2, 3]) as any)
            .filter((x: number) => x > 1)
            .toArray()
    ]);
    same("readable state properties", async ({ stream }) => {
        const r = new stream.Readable({ read() {} });
        const before = [
            r.readable,
            r.readableEnded,
            r.readableFlowing,
            r.readableObjectMode
        ];
        r.on("data", () => {});
        r.push(null);
        await settle();
        return [before, r.readable, r.readableEnded, r.readableFlowing];
    });
});

suite("shim stream - Writable", () => {
    same("write, end, finish, close order", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(chunk, enc, cb) {
                log.push(`_write ${str(chunk)} ${enc}`);
                cb();
            },
            final(cb) {
                log.push("_final");
                cb();
            }
        });
        track(w, log, "w", ["finish", "close"]);
        log.push(w.write("a"));
        w.end("b", () => log.push("end callback"));
        await settle();
        return log;
    });
    same("backpressure and drain", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            highWaterMark: 4,
            write(chunk, enc, cb) {
                setTimeout(cb, 1);
            }
        });
        w.on("drain", () => log.push("drain"));
        log.push(
            w.write("ab"),
            w.write("cd"),
            w.writableLength,
            w.writableNeedDrain
        );
        await settle(30);
        return log;
    });
    same("decodeStrings false keeps strings", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            decodeStrings: false,
            write(chunk, enc, cb) {
                log.push(typeof chunk, enc);
                cb();
            }
        });
        w.write("s", "latin1");
        await settle();
        return log;
    });
    same("cork, uncork and _writev", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(chunk, enc, cb) {
                log.push(`write ${str(chunk)}`);
                cb();
            },
            writev(chunks, cb) {
                log.push(`writev ${chunks.map((c) => str(c.chunk)).join(",")}`);
                cb();
            }
        });
        w.cork();
        w.write("a");
        w.write("b");
        process.nextTick(() => w.uncork());
        await settle();
        return log;
    });
    same("write after end errors", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        w.on("error", (e: any) => log.push(`error ${e.code}`));
        w.end();
        w.write("late", (e: any) => log.push(`callback ${e?.code}`));
        await settle();
        return log;
    });
    same("error in _write destroys", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                cb(new Error("write failed"));
            }
        });
        track(w, log, "w", ["error", "close", "finish"]);
        w.write("x", (e) => log.push(`cb ${e?.message}`));
        await settle();
        return [log, w.destroyed];
    });
    same("writable state properties", async ({ stream }) => {
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        const before = [w.writable, w.writableEnded, w.writableFinished];
        w.end();
        await settle();
        return [before, w.writable, w.writableEnded, w.writableFinished];
    });
});

suite("shim stream - Duplex, Transform, PassThrough", () => {
    same("Transform with flush", async ({ stream }) => {
        const out: string[] = [];
        const t = new stream.Transform({
            transform(chunk, enc, cb) {
                cb(null, str(chunk).toUpperCase());
            },
            flush(cb) {
                this.push("!");
                cb();
            }
        });
        t.on("data", (d) => out.push(str(d)));
        t.write("ab");
        t.end("c");
        await settle();
        return out;
    });
    same("PassThrough objectMode", async ({ stream }) => {
        const p = new stream.PassThrough({ objectMode: true });
        const out: unknown[] = [];
        p.on("data", (d) => out.push(d));
        p.write({ a: 1 });
        p.end(2);
        await settle();
        return out;
    });
    same(
        "Duplex allowHalfOpen false ends the writable side",
        async ({ stream }) => {
            const log: unknown[] = [];
            const d = new stream.Duplex({
                allowHalfOpen: false,
                read() {},
                write(c, e, cb) {
                    cb();
                }
            });
            track(d, log, "d", ["end", "finish", "close"]);
            d.resume();
            d.push(null);
            await settle();
            return [log, d.writableEnded];
        }
    );
    same("Duplex.from", async ({ stream }) => {
        const d = (stream.Duplex as any).from(async function* (
            source: AsyncIterable<unknown>
        ) {
            for await (const c of source) yield str(c) + "!";
        });
        const out: string[] = [];
        d.on("data", (c: unknown) => out.push(str(c)));
        d.end("x");
        await settle();
        return out;
    });
});

suite("shim stream - composition", () => {
    same("pipe with backpressure", async ({ stream }) => {
        const r = stream.Readable.from(["a", "b", "c"], { objectMode: false });
        const got: string[] = [];
        const w = new stream.Writable({
            highWaterMark: 1,
            write(c, e, cb) {
                got.push(str(c));
                setTimeout(cb, 1);
            }
        });
        await new Promise((resolve) => r.pipe(w).on("finish", resolve));
        return got;
    });
    same("unpipe", async ({ stream }) => {
        const r = new stream.Readable({ read() {} });
        const got: string[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                got.push(str(c));
                cb();
            }
        });
        r.pipe(w);
        r.push("a");
        await settle();
        r.unpipe(w);
        r.push("b");
        await settle();
        return got;
    });
    same(
        "pipeline propagates errors and destroys every stream",
        async ({ stream }) => {
            const r = new stream.Readable({ read() {} });
            const t = new stream.Transform({
                transform(c, e, cb) {
                    cb(new Error("transform failed"));
                }
            });
            const w = new stream.Writable({
                write(c, e, cb) {
                    cb();
                }
            });
            const err = await new Promise<Error>((resolve) =>
                stream.pipeline(r, t, w, resolve)
            );
            r.push("x");
            await settle();
            return [err?.message, r.destroyed, t.destroyed, w.destroyed];
        }
    );
    same("pipeline with an async generator", async ({ stream }) => {
        const out: string[] = [];
        await new Promise((resolve, reject) =>
            stream.pipeline(
                stream.Readable.from(["a", "b"]),
                async function* (source: AsyncIterable<unknown>) {
                    for await (const c of source) yield str(c).toUpperCase();
                },
                new stream.Writable({
                    objectMode: true,
                    write(c, e, cb) {
                        out.push(str(c));
                        cb();
                    }
                }),
                (err) => (err ? reject(err) : resolve(null))
            )
        );
        return out;
    });
    same("finished", async ({ stream }) => {
        const r = new stream.Readable({ read() {} });
        const p = new Promise((resolve) =>
            stream.finished(r, (err) => resolve(err?.message ?? "ok"))
        );
        r.resume();
        r.push(null);
        const ok = await p;
        const e = new stream.Readable({ read() {} });
        const p2 = new Promise((resolve) =>
            stream.finished(e, (err) => resolve(err?.message))
        );
        e.destroy(new Error("broken"));
        return [ok, await p2];
    });
    same("stream.promises", async ({ stream }) => {
        const promises = (stream as any).promises;
        if (!promises) return "no stream.promises";
        const out: string[] = [];
        await promises.pipeline(
            stream.Readable.from(["a"]),
            new stream.Writable({
                objectMode: true,
                write(c, e, cb) {
                    out.push(str(c));
                    cb();
                }
            })
        );
        return [typeof promises.finished, out];
    });
    same("addAbortSignal", async ({ stream }) => {
        const controller = new AbortController();
        const r = stream.addAbortSignal(
            controller.signal,
            new stream.Readable({ read() {} })
        );
        const err = new Promise((resolve) =>
            r.on("error", (e: any) => resolve(e.name))
        );
        controller.abort();
        return err;
    });
    same("compose", async ({ stream }) => {
        const c = (stream as any).compose(
            new stream.Transform({
                transform(ch, e, cb) {
                    cb(null, str(ch) + "1");
                }
            }),
            new stream.Transform({
                transform(ch, e, cb) {
                    cb(null, str(ch) + "2");
                }
            })
        );
        const out: string[] = [];
        c.on("data", (d: unknown) => out.push(str(d)));
        c.end("x");
        await settle();
        return out;
    });
    same("web stream interop", async ({ stream }) => {
        const web = (stream.Readable as any).toWeb(
            stream.Readable.from(["a", "b"])
        );
        const reader = web.getReader();
        const out: string[] = [];
        for (let r = await reader.read(); !r.done; r = await reader.read())
            out.push(str(r.value));
        const back = (stream.Readable as any).fromWeb(
            new ReadableStream({
                start(c) {
                    c.enqueue("w");
                    c.close();
                }
            }),
            { objectMode: true }
        );
        for await (const c of back) out.push(str(c));
        return out;
    });
    same("exports", (m) =>
        [
            "Readable",
            "Writable",
            "Duplex",
            "Transform",
            "PassThrough",
            "Stream",
            "pipeline",
            "finished",
            "addAbortSignal",
            "compose",
            "isReadable",
            "isErrored",
            "isDisturbed",
            "getDefaultHighWaterMark",
            "setDefaultHighWaterMark",
            "duplexPair"
        ].map((k) => [k, typeof (m.stream as any)[k]])
    );
    same("Stream is the legacy base class", ({ stream }) => [
        typeof stream.Stream,
        new stream.Readable() instanceof stream.Stream,
        typeof (stream.Stream.prototype as any).pipe
    ]);
});

// Stage 3: the lib's own stream (lib/stream/*.ts) against Node 24

type SubEnv = Env & {
    promises: typeof nodePromises;
    consumers: typeof nodeConsumers;
    web: typeof nodeWeb;
};
const sub = sameFor<SubEnv>(
    "stream",
    {
        ...shim,
        promises: libPromises as any,
        consumers: libConsumers as any,
        web: libWeb as any
    },
    { ...node, promises: nodePromises, consumers: nodeConsumers, web: nodeWeb }
);

const errorCode = (e: any) => `${e?.name} ${e?.code}`;

suite("shim stream - Readable details", () => {
    same("'readable' with read(0) and highWaterMark", async ({ stream }) => {
        const log: unknown[] = [];
        let n = 0;
        const r = new stream.Readable({
            highWaterMark: 4,
            read() {
                log.push(`_read ${r.readableLength}`);
                if (n < 3) this.push(String(n++).repeat(3));
                else this.push(null);
            }
        });
        r.on("readable", () => {
            log.push(`readable ${r.readableLength}`);
            let chunk;
            while ((chunk = r.read()) !== null) log.push(`read ${str(chunk)}`);
        });
        r.on("end", () => log.push("end"));
        r.on("close", () => log.push("close"));
        await settle();
        return log;
    });
    same(
        "read(n) larger than the buffer and past the end",
        async ({ stream }) => {
            const r = new stream.Readable({ read() {} });
            r.push("abc");
            const log: unknown[] = [str(r.read(5)), r.readableLength];
            r.push("de");
            r.push(null);
            log.push(str(r.read(5)), str(r.read(5)), r.readableEnded);
            await settle();
            log.push(r.readableEnded);
            return log;
        }
    );
    same("read(n) across chunks and setEncoding", async ({ stream }) => {
        const r = new stream.Readable({ read() {} });
        r.push("ab");
        r.push("cd");
        r.push("ef");
        const log: unknown[] = [str(r.read(3)), str(r.read(1))];
        r.setEncoding("hex");
        log.push(r.read(2), r.read(), r.readableEncoding);
        return log;
    });
    same("highWaterMark raised by read(n)", ({ stream }) => {
        const r = new stream.Readable({ highWaterMark: 4, read() {} });
        r.read(100);
        return r.readableHighWaterMark;
    });
    same("push after EOF and unshift after end", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.on("error", (e) => log.push(errorCode(e)));
        r.push(null);
        log.push(r.push("late"));
        await settle();
        const r2 = new stream.Readable({ read() {} });
        r2.on("error", (e) => log.push(errorCode(e)));
        r2.on("end", () => r2.unshift("x"));
        r2.resume();
        r2.push(null);
        await settle();
        return log;
    });
    same("invalid chunk types", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.on("error", (e) => log.push(errorCode(e)));
        log.push(r.push(42 as any));
        await settle();
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        try {
            w.write(42 as any);
        } catch (e) {
            log.push(errorCode(e));
        }
        try {
            w.write(null);
        } catch (e) {
            log.push(errorCode(e));
        }
        return log;
    });
    same("_read not implemented", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable();
        r.on("error", (e) => log.push(errorCode(e)));
        r.on("close", () => log.push("close"));
        r.read();
        await settle();
        return log;
    });
    same("pause, resume and their events", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        track(r, log, "r", ["pause", "resume", "data", "end"]);
        log.push(`flowing ${r.readableFlowing}`);
        r.pause();
        log.push(`flowing ${r.readableFlowing} paused ${r.isPaused()}`);
        r.push("a");
        r.on("data", () => {});
        await settle();
        log.push(`after data listener ${r.readableFlowing}`);
        r.resume();
        r.push(null);
        await settle();
        return log;
    });
    same(
        "removing the 'readable' listener resumes the flow",
        async ({ stream }) => {
            const log: unknown[] = [];
            const r = new stream.Readable({ read() {} });
            const onReadable = () => log.push("readable");
            r.on("readable", onReadable);
            r.on("data", (d) => log.push(`data ${str(d)}`));
            r.push("a");
            await settle();
            log.push(`flowing ${r.readableFlowing}`);
            r.removeListener("readable", onReadable);
            await settle();
            log.push(`flowing ${r.readableFlowing}`);
            r.push("b");
            await settle();
            return log;
        }
    );
    same("multiple 'data' listeners and once", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.once("data", (d) => log.push(`once ${str(d)}`));
        r.on("data", (d) => log.push(`on ${str(d)}`));
        r.push("a");
        r.push("b");
        r.push(null);
        await settle();
        return log;
    });
    same(
        "objectMode read() returns one object, falsy values",
        async ({ stream }) => {
            const r = new stream.Readable({ objectMode: true, read() {} });
            r.push(0);
            r.push("");
            r.push(false);
            return [r.readableLength, r.read(), r.read(), r.read(), r.read()];
        }
    );
    same("encoding option and defaultEncoding", async ({ stream, Buffer }) => {
        const out: unknown[] = [];
        const r = new stream.Readable({ encoding: "base64", read() {} });
        r.on("data", (d) => out.push(d));
        r.push(Buffer.from("hello"));
        r.push("aGk=", "base64");
        r.push(null);
        await settle();
        const r2 = new stream.Readable({
            defaultEncoding: "hex",
            read() {}
        } as any);
        r2.push("6869");
        out.push(str(r2.read()));
        return out;
    });
    same(
        "Uint8Array and DataView chunks become Buffers",
        async ({ stream, Buffer }) => {
            const r = new stream.Readable({ read() {} });
            r.push(new Uint8Array([104, 105]));
            r.push(new DataView(new Uint8Array([33]).buffer));
            const chunk = r.read();
            return [Buffer.isBuffer(chunk), str(chunk)];
        }
    );
    same("destroy while reading, destroyed and closed", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        track(r, log, "r", ["data", "end", "close", "error"]);
        r.push("a");
        r.destroy();
        log.push(r.push("b"), r.destroyed, r.closed, r.readableAborted);
        await settle();
        log.push(r.closed, r.readable);
        return log;
    });
    same("emitClose false and autoDestroy false", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({
            emitClose: false,
            autoDestroy: false,
            read() {}
        });
        track(r, log, "r", ["end", "close"]);
        r.resume();
        r.push(null);
        await settle();
        log.push(r.destroyed);
        r.destroy();
        await settle();
        log.push(r.destroyed);
        const w = new stream.Writable({
            autoDestroy: false,
            write(c, e, cb) {
                cb(new Error("bad"));
            }
        });
        track(w, log, "w", ["error", "close"]);
        w.write("x");
        await settle();
        log.push(w.destroyed, w.errored?.message);
        return log;
    });
    same("construct delays _read and destroy", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({
            construct(cb) {
                log.push("construct");
                setTimeout(() => {
                    log.push("constructed");
                    cb();
                }, 5);
            },
            read() {
                log.push("_read");
                this.push(null);
            },
            destroy(err, cb) {
                log.push("_destroy");
                cb(err);
            }
        });
        track(r, log, "r", ["end", "close"]);
        r.resume();
        await settle(30);
        const r2 = new stream.Readable({
            construct(cb) {
                setTimeout(cb, 5);
            },
            read() {},
            destroy(err, cb) {
                log.push("r2 _destroy");
                cb(err);
            }
        });
        r2.on("close", () => log.push("r2 close"));
        r2.destroy();
        log.push("r2 destroy called");
        await settle(30);
        return log;
    });
    same("construct error", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            construct(cb) {
                cb(new Error("no"));
            },
            write(c, e, cb) {
                log.push("write");
                cb();
            }
        });
        track(w, log, "w", ["error", "close", "finish"]);
        w.write("a", (e) => log.push(`cb ${e?.message}`));
        await settle();
        return log;
    });
    same("Readable.call and inherits", async ({ stream }) => {
        function Counter(this: any) {
            stream.Readable.call(this, { objectMode: true });
            this.n = 0;
        }
        inherits(Counter, stream.Readable);
        Counter.prototype._read = function () {
            this.push(this.n < 3 ? this.n++ : null);
        };
        const c = new (Counter as any)();
        const out: unknown[] = [];
        for await (const v of c) out.push(v);
        function Upper(this: any) {
            stream.Transform.call(this);
        }
        inherits(Upper, stream.Transform);
        Upper.prototype._transform = function (chunk: any, e: string, cb: any) {
            cb(null, str(chunk).toUpperCase());
        };
        const u = new (Upper as any)();
        u.end("abc");
        out.push(
            str(u.read()),
            u instanceof stream.Transform,
            u instanceof stream.Writable
        );
        return out;
    });
    same("class extends", async ({ stream }) => {
        class Source extends stream.Readable {
            n = 0;
            _read() {
                this.push(this.n < 2 ? `s${this.n++}` : null);
            }
        }
        class Sink extends stream.Writable {
            got: string[] = [];
            _write(chunk: any, e: string, cb: () => void) {
                this.got.push(str(chunk));
                cb();
            }
        }
        const sink = new Sink();
        await new Promise((resolve) =>
            new Source().pipe(sink).on("finish", resolve)
        );
        return [
            sink.got,
            sink instanceof stream.Writable,
            sink instanceof stream.Readable
        ];
    });
    same("wrap an old-style stream", async ({ stream }) => {
        const { EventEmitter } = await import("node:events");
        const old: any = new EventEmitter();
        old.pause = () => {};
        old.resume = () => {};
        const r = new stream.Readable({ objectMode: true }).wrap(old);
        const out: unknown[] = [];
        r.on("data", (d) => out.push(d));
        r.on("end", () => out.push("end"));
        old.emit("data", "a");
        old.emit("data", "b");
        old.emit("end");
        await settle();
        return out;
    });
    same("async iterator error and destroyOnReturn", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        r.push("a");
        setTimeout(() => r.destroy(new Error("broken")), 1);
        try {
            for await (const c of r) log.push(str(c));
        } catch (e: any) {
            log.push(`caught ${e.message}`);
        }
        const r2 = stream.Readable.from([1, 2, 3]);
        for await (const v of r2.iterator({ destroyOnReturn: false })) {
            log.push(v);
            break;
        }
        log.push(r2.destroyed);
        for await (const v of r2) log.push(v);
        return log;
    });
    same("Readable.from errors and promises", async ({ stream }) => {
        const log: unknown[] = [];
        function* gen() {
            yield "a";
            throw new Error("gen failed");
        }
        try {
            for await (const c of stream.Readable.from(gen())) log.push(c);
        } catch (e: any) {
            log.push(e.message);
        }
        try {
            stream.Readable.from(42 as any);
        } catch (e) {
            log.push(errorCode(e));
        }
        const values = await stream.Readable.from([
            Promise.resolve(1),
            2,
            Promise.resolve(3)
        ]).toArray();
        log.push(values);
        try {
            await stream.Readable.from([1, null, 2]).toArray();
        } catch (e) {
            log.push(errorCode(e));
        }
        return log;
    });
    same("generator return called on destroy", async ({ stream }) => {
        const log: unknown[] = [];
        async function* gen() {
            try {
                yield 1;
                yield 2;
            } finally {
                log.push("finally");
            }
        }
        const r = stream.Readable.from(gen());
        r.on("close", () => log.push("close"));
        log.push(await new Promise((resolve) => r.once("data", resolve)));
        r.destroy();
        await settle();
        return log;
    });
    same("operators", async ({ stream }) => {
        const from = (v: unknown[]) => stream.Readable.from(v) as any;
        const seen: unknown[] = [];
        await from([1, 2]).forEach((x: number) => seen.push(x));
        return [
            seen,
            await from([1, 2, 3]).reduce((a: number, b: number) => a + b, 10),
            await from([1, 2, 3]).reduce((a: number, b: number) => a + b),
            await from([1, 2, 3]).some((x: number) => x > 2),
            await from([1, 2, 3]).every((x: number) => x > 2),
            await from([1, 2, 3]).find((x: number) => x > 1),
            await from([1, 2])
                .flatMap((x: number) => [x, x])
                .toArray(),
            await from([1, 2, 3, 4]).drop(1).take(2).toArray(),
            await from([1, 2, 3])
                .map(async (x: number) => x * 10, { concurrency: 2 })
                .toArray(),
            typeof (stream.Readable.prototype as any).asIndexedPairs
        ];
    });
    same("operator errors", async ({ stream }) => {
        const from = (v: unknown[]) => stream.Readable.from(v) as any;
        const log: unknown[] = [];
        for (const fn of [
            () => from([]).reduce((a: number, b: number) => a + b),
            () =>
                from([1])
                    .map(() => {
                        throw new Error("in map");
                    })
                    .toArray(),
            () => from([1]).map(() => 1, { concurrency: 0 }),
            () => from([1]).drop(-1),
            () => from([1]).filter("x")
        ]) {
            try {
                await fn();
            } catch (e: any) {
                log.push(
                    `${errorCode(e)} ${e.message === "in map" ? "in map" : ""}`
                );
            }
        }
        return log;
    });
    same("readable state getters", async ({ stream }) => {
        const r = new stream.Readable({ objectMode: true, read() {} });
        const keys = [
            "readable",
            "readableAborted",
            "readableDidRead",
            "readableEncoding",
            "readableEnded",
            "readableFlowing",
            "readableHighWaterMark",
            "readableLength",
            "readableObjectMode",
            "destroyed",
            "closed",
            "errored"
        ];
        const snap = () => keys.map((k) => [k, (r as any)[k]]);
        const before = snap();
        r.push(1);
        r.read();
        const after = snap();
        const s = (r as any)._readableState;
        return [
            before,
            after,
            [
                s.ended,
                s.endEmitted,
                s.flowing,
                s.length,
                s.pipes.length,
                s.highWaterMark
            ]
        ];
    });
});

suite("shim stream - Writable details", () => {
    same("write callbacks, drain and finish order", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            highWaterMark: 3,
            write(chunk, e, cb) {
                log.push(`_write ${str(chunk)}`);
                setTimeout(cb, 1);
            }
        });
        track(w, log, "w", ["drain", "prefinish", "finish", "close"]);
        for (const c of ["a", "bb", "c"]) {
            log.push(w.write(c, () => log.push(`cb ${c}`)));
        }
        w.end(() => log.push("end cb"));
        await settle(40);
        return log;
    });
    same("sync write callbacks are deferred", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(chunk, e, cb) {
                cb();
            }
        });
        w.write("a", () => log.push("cb a"));
        w.write("b", () => log.push("cb b"));
        log.push("sync");
        w.end("c", () => log.push("end cb"));
        w.on("finish", () => log.push("finish"));
        await settle();
        return log;
    });
    same("objectMode writes and writev", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            objectMode: true,
            write(chunk, e, cb) {
                log.push(`write ${JSON.stringify(chunk)}`);
                setTimeout(cb, 1);
            },
            writev(chunks, cb) {
                log.push(
                    `writev ${chunks.length} ${(chunks as any).allBuffers}`
                );
                cb();
            }
        });
        w.write({ a: 1 });
        w.write(2);
        w.write("three");
        w.end();
        w.on("finish", () => log.push("finish"));
        await settle(30);
        return log;
    });
    same("final, final error and multiple callbacks", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            },
            final(cb) {
                log.push("_final");
                setTimeout(() => cb(new Error("final failed")), 1);
            }
        });
        track(w, log, "w", ["prefinish", "finish", "error", "close"]);
        w.end(() => log.push("end cb"));
        await settle();
        const w2 = new stream.Writable({
            write(c, e, cb) {
                cb();
                cb();
            }
        });
        w2.on("error", (e) => log.push(errorCode(e)));
        w2.write("x");
        await settle();
        return log;
    });
    same(
        "end twice, end after finish, write after destroy",
        async ({ stream }) => {
            const log: unknown[] = [];
            const w = new stream.Writable({
                write(c, e, cb) {
                    cb();
                }
            });
            w.on("error", (e) => log.push(`error ${errorCode(e)}`));
            w.end();
            w.end((e: any) => log.push(`second end ${errorCode(e)}`));
            await settle();
            w.end((e: any) => log.push(`third end ${errorCode(e)}`));
            const w2 = new stream.Writable({
                write(c, e, cb) {
                    cb();
                }
            });
            w2.on("error", (e) => log.push(`w2 error ${errorCode(e)}`));
            w2.destroy();
            w2.write("x", (e) => log.push(`w2 cb ${errorCode(e)}`));
            await settle();
            return log;
        }
    );
    same("destroy calls the buffered callbacks back", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                setTimeout(cb, 5);
            }
        });
        w.on("error", (e) => log.push(`error ${e.message}`));
        w.on("close", () => log.push("close"));
        w.write("a", (e) => log.push(`a ${errorCode(e)}`));
        w.write("b", (e) => log.push(`b ${errorCode(e)}`));
        w.end((e: any) => log.push(`end ${errorCode(e)}`));
        w.destroy(new Error("stop"));
        await settle(30);
        return log;
    });
    same("_write not implemented, _writev only", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable();
        w.on("error", (e) => log.push(errorCode(e)));
        try {
            w.write("a");
        } catch (e) {
            log.push(`threw ${errorCode(e)}`);
        }
        const w2 = new stream.Writable({
            writev(chunks, cb) {
                log.push(`writev ${chunks.map((c) => str(c.chunk))}`);
                cb();
            }
        });
        w2.write("x");
        await settle();
        return log;
    });
    same("setDefaultEncoding and encodings", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(chunk, enc, cb) {
                log.push(`${str(chunk)} ${enc}`);
                cb();
            }
        });
        w.setDefaultEncoding("HEX" as any);
        w.write("6869");
        w.write("aGk=", "base64");
        try {
            w.setDefaultEncoding("nope" as any);
        } catch (e) {
            log.push(errorCode(e));
        }
        try {
            w.write("x", "nope" as any);
        } catch (e) {
            log.push(errorCode(e));
        }
        await settle();
        return log;
    });
    same("cork, nested cork, end uncorks", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            writev(chunks, cb) {
                log.push(`writev ${chunks.map((c) => str(c.chunk)).join(",")}`);
                cb();
            }
        });
        w.cork();
        w.cork();
        w.write("a");
        w.uncork();
        log.push(`corked ${w.writableCorked}`);
        w.write("b");
        w.end("c");
        log.push(`corked ${w.writableCorked}`);
        await settle();
        return log;
    });
    same("writable state getters", async ({ stream }) => {
        const w = new stream.Writable({
            highWaterMark: 2,
            write(c, e, cb) {
                setTimeout(cb, 1);
            }
        });
        const keys = [
            "writable",
            "writableAborted",
            "writableCorked",
            "writableEnded",
            "writableFinished",
            "writableHighWaterMark",
            "writableLength",
            "writableNeedDrain",
            "writableObjectMode",
            "destroyed",
            "closed",
            "errored"
        ];
        const snap = () => keys.map((k) => [k, (w as any)[k]]);
        const log: unknown[] = [snap()];
        w.write("abc");
        log.push(snap(), ((w as any).writableBuffer as unknown[]).length);
        w.end();
        log.push(snap());
        await settle(20);
        log.push(snap());
        const s = (w as any)._writableState;
        log.push([
            s.ending,
            s.ended,
            s.finished,
            s.length,
            s.pendingcb,
            s.finalCalled
        ]);
        return log;
    });
    same("a Writable cannot pipe", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        w.on("error", (e) => log.push(errorCode(e)));
        (w as any).pipe(new stream.PassThrough());
        await settle();
        return log;
    });
});

suite("shim stream - Duplex and Transform details", () => {
    same("Transform backpressure on the readable side", async ({ stream }) => {
        const log: unknown[] = [];
        const t = new stream.Transform({
            readableHighWaterMark: 2,
            writableHighWaterMark: 2,
            transform(chunk, e, cb) {
                log.push(`transform ${str(chunk)}`);
                cb(null, chunk);
            }
        });
        for (const c of ["a", "b", "c", "d"]) log.push(t.write(c));
        log.push(t.readableLength, t.writableLength);
        await settle();
        log.push(str(t.read()), t.readableLength);
        await settle();
        log.push(t.readableLength, t.writableLength);
        return log;
    });
    same(
        "Transform push in _transform, flush data and errors",
        async ({ stream }) => {
            const out: unknown[] = [];
            const t = new stream.Transform({
                objectMode: true,
                transform(chunk, e, cb) {
                    this.push(chunk);
                    this.push(chunk);
                    cb();
                },
                flush(cb) {
                    cb(null, "flushed");
                }
            });
            t.on("data", (d) => out.push(d));
            t.on("end", () => out.push("end"));
            t.end(1);
            await settle();
            const t2 = new stream.Transform({
                transform(c, e, cb) {
                    cb();
                },
                flush(cb) {
                    cb(new Error("flush failed"));
                }
            });
            t2.on("error", (e) => out.push(e.message));
            t2.on("close", () => out.push("t2 close"));
            t2.resume();
            t2.end();
            await settle();
            const t3 = new stream.Transform();
            t3.on("error", (e) => out.push(errorCode(e)));
            try {
                t3.write("x");
            } catch (e) {
                out.push(`threw ${errorCode(e)}`);
            }
            await settle();
            return out;
        }
    );
    same("PassThrough event order", async ({ stream }) => {
        const log: unknown[] = [];
        const p = new stream.PassThrough();
        track(p, log, "p", [
            "data",
            "readable",
            "prefinish",
            "finish",
            "end",
            "close"
        ]);
        p.write("a");
        p.end("b");
        await settle();
        return log;
    });
    same(
        "Duplex sides, half open and readable/writable false",
        async ({ stream }) => {
            const log: unknown[] = [];
            const d = new stream.Duplex({
                read() {},
                write(c, e, cb) {
                    log.push(`write ${str(c)}`);
                    cb();
                }
            });
            track(d, log, "d", ["finish", "end", "close"]);
            d.end("x");
            await settle();
            log.push(`readable ${d.readable} writable ${d.writable}`);
            d.push(null);
            d.resume();
            await settle();
            const ro = new stream.Duplex({ writable: false, read() {} } as any);
            const wo = new stream.Duplex({
                readable: false,
                write(c: unknown, e: string, cb: () => void) {
                    cb();
                }
            } as any);
            log.push(ro.writable, ro.readable, wo.readable, wo.writable);
            log.push(ro.writableEnded, wo.readableEnded);
            return log;
        }
    );
    same("Duplex objectMode per side", async ({ stream }) => {
        const d = new stream.Duplex({
            readableObjectMode: true,
            writableHighWaterMark: 5,
            read() {},
            write(c, e, cb) {
                cb();
            }
        });
        return [
            d.readableObjectMode,
            d.writableObjectMode,
            d.readableHighWaterMark,
            d.writableHighWaterMark
        ];
    });
    same("Duplex destroy with error", async ({ stream }) => {
        const log: unknown[] = [];
        const d = new stream.Duplex({
            read() {},
            write(c, e, cb) {
                cb();
            }
        });
        track(d, log, "d", ["error", "close", "end", "finish"]);
        d.destroy(new Error("both"));
        log.push(d.destroyed, d.readable, d.writable);
        await settle();
        log.push(d.readableAborted, d.writableAborted, d.errored?.message);
        return log;
    });
    same("Duplex.from variants", async ({ stream }) => {
        const out: unknown[] = [];
        const fromIterable = stream.Duplex.from(["a", "b"]);
        for await (const c of fromIterable) out.push(c);
        const fromPromise = stream.Duplex.from(Promise.resolve("p"));
        for await (const c of fromPromise) out.push(c);
        const r = stream.Readable.from(["r"]);
        const w = new stream.Writable({
            objectMode: true,
            write(c, e, cb) {
                out.push(`w ${c}`);
                cb();
            }
        });
        const pair = stream.Duplex.from({ readable: r, writable: w } as any);
        pair.end("x");
        for await (const c of pair) out.push(c);
        const sink = stream.Duplex.from(async function (
            source: AsyncIterable<unknown>
        ) {
            for await (const c of source) out.push(`sink ${str(c)}`);
        });
        sink.end("s");
        await settle();
        try {
            stream.Duplex.from(42 as any);
        } catch (e) {
            out.push(errorCode(e));
        }
        return out;
    });
    same("duplexPair", async ({ stream }) => {
        const [a, b] = (stream as any).duplexPair();
        const log: unknown[] = [];
        a.on("data", (d: unknown) => log.push(`a got ${str(d)}`));
        b.on("data", (d: unknown) => log.push(`b got ${str(d)}`));
        b.on("end", () => log.push("b end"));
        a.write("to b");
        b.write("to a");
        a.end();
        await settle();
        return log;
    });
});

suite("shim stream - pipe, pipeline, finished details", () => {
    same(
        "pipe to two destinations, slowest sets the pace",
        async ({ stream }) => {
            const log: unknown[] = [];
            const r = new stream.Readable({ highWaterMark: 2, read() {} });
            const make = (name: string, delay: number) =>
                new stream.Writable({
                    highWaterMark: 1,
                    write(c, e, cb) {
                        log.push(`${name} ${str(c)}`);
                        setTimeout(cb, delay);
                    }
                });
            const fast = make("fast", 0);
            const slow = make("slow", 5);
            r.pipe(fast);
            r.pipe(slow);
            for (const c of ["1", "2", "3"]) r.push(c);
            r.push(null);
            await new Promise((resolve) => slow.on("finish", resolve));
            return log;
        }
    );
    same("pipe events and end: false", async ({ stream }) => {
        const log: unknown[] = [];
        const r = stream.Readable.from(["a"]);
        const w = new stream.Writable({
            objectMode: true,
            write(c, e, cb) {
                cb();
            }
        });
        w.on("pipe", (src) => log.push(`pipe ${src === r}`));
        w.on("unpipe", (src) => log.push(`unpipe ${src === r}`));
        w.on("finish", () => log.push("finish"));
        r.on("end", () => log.push("end"));
        r.pipe(w, { end: false });
        await settle();
        log.push(`ended ${w.writableEnded}`);
        return log;
    });
    same("pipe stops on a destination error", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        const w = new stream.Writable({
            write(c, e, cb) {
                cb(new Error("dest failed"));
            }
        });
        w.on("error", (e) => log.push(`w error ${e.message}`));
        r.on("unpipe", () => log.push("unpipe on r"));
        w.on("unpipe", () => log.push("unpipe"));
        r.pipe(w);
        r.push("a");
        await settle();
        log.push(
            `pipes ${r.readableFlowing} ${(r as any)._readableState.pipes.length}`
        );
        return log;
    });
    same("pipeline error in the source", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        const p = new stream.PassThrough();
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        track(p, log, "p", ["close", "error"]);
        track(w, log, "w", ["close", "error"]);
        stream.pipeline(r, p, w, (err) => log.push(`done ${err?.message}`));
        r.destroy(new Error("source failed"));
        await settle();
        return log;
    });
    same("pipeline premature close", async ({ stream }) => {
        const log: unknown[] = [];
        const r = new stream.Readable({ read() {} });
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        stream.pipeline(r, w, (err) => log.push(`done ${errorCode(err)}`));
        w.destroy();
        await settle();
        log.push(r.destroyed);
        return log;
    });
    sub("pipeline with an AbortSignal", async ({ promises, stream }) => {
        const controller = new AbortController();
        const r = new stream.Readable({ read() {} });
        const p = promises.pipeline(
            r,
            new stream.Writable({
                write(c, e, cb) {
                    cb();
                }
            }),
            { signal: controller.signal }
        );
        controller.abort();
        try {
            await p;
            return "resolved";
        } catch (e) {
            return [errorCode(e), r.destroyed];
        }
    });
    sub(
        "pipeline of generators, value of the last function",
        async ({ promises, stream }) => {
            const value = await promises.pipeline(
                async function* () {
                    yield "a";
                    yield "b";
                },
                async function* (source: AsyncIterable<string>) {
                    for await (const c of source) yield c.toUpperCase();
                },
                async function (source: AsyncIterable<string>) {
                    let all = "";
                    for await (const c of source) all += c;
                    return all;
                }
            );
            const out: string[] = [];
            await promises.pipeline(
                ["x", "y"],
                new stream.Writable({
                    objectMode: true,
                    write(c, e, cb) {
                        out.push(c);
                        cb();
                    }
                })
            );
            return [value, out];
        }
    );
    sub(
        "pipeline generator error and missing args",
        async ({ promises, stream }) => {
            const log: unknown[] = [];
            try {
                await promises.pipeline(
                    stream.Readable.from(["a"]),
                    async function* (source: AsyncIterable<unknown>) {
                        for await (const _ of source)
                            throw new Error("in transform");
                        yield "never";
                    },
                    new stream.PassThrough({ objectMode: true })
                );
            } catch (e: any) {
                log.push(e.message);
            }
            try {
                (stream.pipeline as any)(stream.Readable.from([]), () => {});
            } catch (e) {
                log.push(errorCode(e));
            }
            try {
                (stream.pipeline as any)(
                    stream.Readable.from([]),
                    new stream.PassThrough()
                );
            } catch (e) {
                log.push(errorCode(e));
            }
            return log;
        }
    );
    sub(
        "pipeline to and from web streams",
        async ({ promises, stream, web }) => {
            const out: unknown[] = [];
            await promises.pipeline(
                new web.ReadableStream({
                    start(c) {
                        c.enqueue("w1");
                        c.enqueue("w2");
                        c.close();
                    }
                }) as any,
                new stream.Writable({
                    objectMode: true,
                    write(c, e, cb) {
                        out.push(c);
                        cb();
                    }
                })
            );
            await promises.pipeline(
                stream.Readable.from(["n1", "n2"]),
                new web.WritableStream({
                    write(c) {
                        out.push(`web ${c}`);
                    }
                }) as any
            );
            return out;
        }
    );
    same("finished on a Writable, cleanup, options", async ({ stream }) => {
        const log: unknown[] = [];
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        stream.finished(w, (err) => log.push(`finished ${err?.message}`));
        const cleanup = stream.finished(w, () => log.push("never"));
        cleanup();
        w.end("x");
        await settle();
        const d = new stream.Duplex({
            read() {},
            write(c, e, cb) {
                cb();
            }
        });
        stream.finished(d, { readable: false }, (err) =>
            log.push(`duplex writable side ${err?.message}`)
        );
        d.end();
        await settle();
        const ended = new stream.Readable({ read() {} });
        ended.resume();
        ended.push(null);
        await settle();
        stream.finished(ended, (err) =>
            log.push(`already ended ${err?.message}`)
        );
        await settle();
        try {
            stream.finished({} as any, () => {});
        } catch (e) {
            log.push(errorCode(e));
        }
        return log;
    });
    same("finished with an AbortSignal", async ({ stream }) => {
        const controller = new AbortController();
        const r = new stream.Readable({ read() {} });
        const p = new Promise((resolve) =>
            stream.finished(r, { signal: controller.signal }, (err) =>
                resolve(errorCode(err))
            )
        );
        controller.abort();
        return [await p, r.destroyed];
    });
    sub("stream/promises finished", async ({ promises, stream }) => {
        const r = stream.Readable.from(["a"]);
        r.resume();
        await promises.finished(r);
        const e = new stream.Readable({ read() {} });
        const p = promises.finished(e);
        e.destroy(new Error("failed"));
        try {
            await p;
        } catch (err: any) {
            return ["rejected", err.message];
        }
        return "resolved";
    });
    same(
        "addAbortSignal on a Writable and an aborted signal",
        async ({ stream }) => {
            const log: unknown[] = [];
            const w = new stream.Writable({
                write(c, e, cb) {
                    cb();
                }
            });
            stream.addAbortSignal(AbortSignal.abort(), w);
            w.on("error", (e) => log.push(errorCode(e)));
            w.on("close", () => log.push("close"));
            await settle();
            const controller = new AbortController();
            const r = new stream.Readable({
                signal: controller.signal,
                read() {}
            });
            r.on("error", (e) => log.push(`option ${errorCode(e)}`));
            controller.abort();
            await settle();
            try {
                stream.addAbortSignal({} as any, w);
            } catch (e) {
                log.push(errorCode(e));
            }
            return log;
        }
    );
    same("compose with functions and Readable.compose", async ({ stream }) => {
        const c = (stream as any).compose(
            async function* (source: AsyncIterable<unknown>) {
                for await (const chunk of source) yield str(chunk) + "1";
            },
            new stream.Transform({
                objectMode: true,
                transform(ch, e, cb) {
                    cb(null, str(ch) + "2");
                }
            })
        );
        c.end("x");
        const out: unknown[] = await c.toArray();
        const composed = (stream.Readable.from(["a", "b"]) as any).compose(
            async function* (source: AsyncIterable<string>) {
                for await (const s of source) yield s.toUpperCase();
            }
        );
        out.push(await composed.toArray());
        return out;
    });
    same("stream.destroy and the predicates", async ({ stream }) => {
        const r = new stream.Readable({ read() {} });
        const w = new stream.Writable({
            write(c, e, cb) {
                cb();
            }
        });
        const s = stream as any;
        const before = [
            s.isReadable(r),
            s.isWritable(w),
            s.isErrored(r),
            s.isDisturbed(r),
            s.isDestroyed(r)
        ];
        r.push("a");
        r.read();
        s.destroy(r, new Error("x"));
        r.on("error", () => {});
        await settle();
        return [
            before,
            s.isReadable(r),
            s.isErrored(r),
            s.isDisturbed(r),
            s.isDestroyed(r),
            s.isReadable({})
        ];
    });
    same("default highWaterMark", ({ stream }) => {
        const s = stream as any;
        const defaults = [
            s.getDefaultHighWaterMark(false),
            s.getDefaultHighWaterMark(true)
        ];
        s.setDefaultHighWaterMark(false, 1024);
        const changed = new stream.Readable().readableHighWaterMark;
        s.setDefaultHighWaterMark(false, defaults[0]);
        let error;
        try {
            s.setDefaultHighWaterMark(false, -1);
        } catch (e) {
            error = errorCode(e);
        }
        let bad;
        try {
            new stream.Readable({ highWaterMark: 1.5 });
        } catch (e) {
            bad = errorCode(e);
        }
        return [
            defaults,
            changed,
            error,
            bad,
            new stream.Readable({ objectMode: true }).readableHighWaterMark
        ];
    });
    same("Stream legacy pipe", async ({ stream }) => {
        const log: unknown[] = [];
        const src: any = new stream.Stream();
        src.readable = true;
        const dest = new stream.Writable({
            write(c, e, cb) {
                log.push(str(c));
                cb();
            }
        });
        dest.on("finish", () => log.push("finish"));
        src.pipe(dest);
        src.emit("data", "a");
        src.emit("end");
        await settle();
        function Legacy(this: any) {
            stream.Stream.call(this);
        }
        inherits(Legacy, stream.Stream);
        return [
            log,
            new (Legacy as any)() instanceof stream.Stream,
            typeof (Legacy as any).prototype.on
        ];
    });
    same("require shape", ({ stream }) => {
        const s = stream as any;
        return [
            Object.keys(s).sort(),
            Object.getOwnPropertyNames(s.Readable).sort(),
            Object.getOwnPropertyNames(s.Writable).sort(),
            Object.getOwnPropertyNames(s.Duplex).sort(),
            typeof s.promises.pipeline,
            s.Stream === s,
            typeof s._uint8ArrayToBuffer
        ];
    });
});

suite("shim stream - web streams and consumers", () => {
    sub("stream/web exports the web stream classes", ({ web }) =>
        [
            "ReadableStream",
            "WritableStream",
            "TransformStream",
            "ByteLengthQueuingStrategy",
            "CountQueuingStrategy",
            "TextEncoderStream",
            "TextDecoderStream"
        ].map((k) => [k, typeof (web as any)[k]])
    );
    same("Writable.toWeb and fromWeb", async ({ stream }) => {
        const got: string[] = [];
        const node = new stream.Writable({
            write(c, e, cb) {
                got.push(str(c));
                cb();
            }
        });
        const writer = (stream.Writable as any).toWeb(node).getWriter();
        await writer.write(new Uint8Array([104, 105]));
        await writer.close();
        const chunks: unknown[] = [];
        const fromWeb = (stream.Writable as any).fromWeb(
            new WritableStream({
                write(c) {
                    chunks.push(
                        c instanceof Uint8Array
                            ? `<${Buffer.from(c).toString()}>`
                            : c
                    );
                }
            })
        );
        fromWeb.write("str");
        await new Promise((resolve) => fromWeb.end(resolve));
        return [got, chunks];
    });
    same("Duplex.toWeb and fromWeb", async ({ stream }) => {
        const echo = new stream.PassThrough();
        const { readable, writable } = (stream.Duplex as any).toWeb(echo);
        const writer = writable.getWriter();
        writer.write(new Uint8Array([97]));
        writer.close();
        const reader = readable.getReader();
        const out: unknown[] = [];
        for (let r = await reader.read(); !r.done; r = await reader.read())
            out.push(str(r.value));
        const transform = new TransformStream({
            transform(chunk, controller) {
                controller.enqueue(String(chunk).toUpperCase());
            }
        });
        const d = (stream.Duplex as any).fromWeb(transform, {
            objectMode: true
        });
        d.end("web");
        for await (const c of d) out.push(c);
        return out;
    });
    same(
        "Readable.fromWeb with an encoding and an error",
        async ({ stream }) => {
            const out: unknown[] = [];
            const r = (stream.Readable as any).fromWeb(
                new ReadableStream({
                    start(c) {
                        c.enqueue(new Uint8Array([0xe2, 0x82]));
                        c.enqueue(new Uint8Array([0xac]));
                        c.close();
                    }
                }),
                { encoding: "utf8" }
            );
            for await (const c of r) out.push(c);
            const failing = (stream.Readable as any).fromWeb(
                new ReadableStream({
                    pull(c) {
                        c.error(new Error("web failed"));
                    }
                })
            );
            try {
                for await (const _ of failing);
            } catch (e: any) {
                out.push(e.message);
            }
            return out;
        }
    );
    sub("consumers", async ({ consumers, stream }) => {
        const bytes = () =>
            stream.Readable.from([Buffer.from('{"a":'), Buffer.from("1}")]);
        return [
            await consumers.text(bytes()),
            await consumers.json(bytes()),
            (await consumers.buffer(bytes())).toString(),
            (await consumers.arrayBuffer(bytes())).byteLength,
            (await consumers.bytes(bytes() as any)).length,
            (await consumers.blob(bytes())).size,
            await consumers.text(stream.Readable.from(["str", "ing"])),
            await consumers.text(
                new ReadableStream({
                    start(c) {
                        c.enqueue(new Uint8Array([0xc3]));
                        c.enqueue(new Uint8Array([0xa9]));
                        c.close();
                    }
                }) as any
            )
        ];
    });
});
