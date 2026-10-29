// Stream, the legacy base class (lib/internal/streams/legacy.js): an
// EventEmitter with the old pipe(). A function constructor, as npm code calls
// `Stream.call(this)`.

import EE from "../events/index.ts";

export function Stream(this: any, opts?: any) {
    (EE as any).call(this, opts);
}
Object.setPrototypeOf(Stream.prototype, EE.prototype);
Object.setPrototypeOf(Stream, EE);

Stream.prototype.pipe = function (this: any, dest: any, options?: any) {
    const source = this;
    let didOnEnd = false;

    function ondata(chunk: any) {
        if (dest.writable && dest.write(chunk) === false && source.pause) {
            source.pause();
        }
    }
    function ondrain() {
        if (source.readable && source.resume) source.resume();
    }
    function onend() {
        if (didOnEnd) return;
        didOnEnd = true;
        dest.end();
    }
    function onclose() {
        if (didOnEnd) return;
        didOnEnd = true;
        if (typeof dest.destroy === "function") dest.destroy();
    }
    function onerror(this: any, er: any) {
        cleanup();
        if (this.listenerCount?.("error") === 0) this.emit("error", er);
    }
    function cleanup() {
        source.removeListener("data", ondata);
        dest.removeListener("drain", ondrain);
        source.removeListener("end", onend);
        source.removeListener("close", onclose);
        source.removeListener("error", onerror);
        dest.removeListener("error", onerror);
        source.removeListener("end", cleanup);
        source.removeListener("close", cleanup);
        dest.removeListener("close", cleanup);
    }

    source.on("data", ondata);
    dest.on("drain", ondrain);
    if (!dest._isStdio && (!options || options.end !== false)) {
        source.on("end", onend);
        source.on("close", onclose);
    }
    prependListener(source, "error", onerror);
    prependListener(dest, "error", onerror);
    source.on("end", cleanup);
    source.on("close", cleanup);
    dest.on("close", cleanup);
    dest.emit("pipe", source);
    return dest;
};

Stream.prototype.eventNames = function eventNames(this: any) {
    const names: (string | symbol)[] = [];
    for (const key of Reflect.ownKeys(this._events)) {
        const value = this._events[key];
        if (
            typeof value === "function" ||
            (Array.isArray(value) && value.length > 0)
        ) {
            names.push(key);
        }
    }
    return names;
};

export function prependListener(emitter: any, event: string, fn: Function) {
    if (typeof emitter.prependListener === "function") {
        return emitter.prependListener(event, fn);
    }
    const events = emitter._events;
    if (!events || !events[event]) emitter.on(event, fn);
    else if (Array.isArray(events[event])) events[event].unshift(fn);
    else events[event] = [fn, events[event]];
}
