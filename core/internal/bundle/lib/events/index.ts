// node:events (Node 22), improvements/shim/plan.md 5.4.
//
// EventEmitter is a function constructor, not a class: npm code calls
// `EventEmitter.call(this)` and sets prototypes by hand (readable-stream),
// and `class X extends EventEmitter` works on it all the same. The state is
// Node's: `_events` (a null-prototype object of a listener or an array of
// listeners per event), `_eventsCount` and `_maxListeners`, which some
// packages read directly.
//
// `require("events")` gets the EventEmitter function with every static on
// it, as in Node: it is the "module.exports" export (bundle.go,
// libRequireAdapter).
//
// The bundled size counts (shell bench, `size events`): the code is dense,
// made of function declarations (esbuild hoists them out of the wrapper a
// require() of the module adds), and the errors have Node's codes with
// short messages.

import type * as NodeEvents from "node:events";

type Name = string | symbol;
type Fn = ((...args: any[]) => unknown) & { listener?: Fn };
type List = Fn[] & { warned?: boolean };

interface Emitter {
    _events: { [type: Name]: Fn | List };
    _eventsCount: number;
    _maxListeners: number;
    [key: symbol]: any;
    constructor: Function;
    emit(type: Name, ...args: any[]): boolean;
    on(type: Name, fn: Fn): Emitter;
    removeListener(type: Name, fn: Fn): Emitter;
    removeAllListeners(type?: Name): Emitter;
}

type Options = { captureRejections?: boolean };

const kCapture = Symbol("kCapture");
const kRejection = Symbol.for("nodejs.rejection");
const errorMonitor = Symbol("events.errorMonitor");
const kMax = Symbol("events.maxEventTargetListeners");
const kDispose: symbol = (Symbol as any).dispose || Symbol("dispose");

let defaultMax = 10;
let captureRejections = false;

// errors with Node's codes

function nodeError(Type: ErrorConstructor, code: string, message: string) {
    return Object.assign(new Type(message), { code });
}

function invalid(name: string, expected: string) {
    const message = `The "${name}" argument must be ${expected}`;
    return nodeError(TypeError, "ERR_INVALID_ARG_TYPE", message);
}

function abortError(signal: AbortSignal) {
    const message = "The operation was aborted";
    const error = new Error(message, { cause: signal.reason });
    return Object.assign(error, { name: "AbortError", code: "ABORT_ERR" });
}

function check(value: unknown, name: string, type: string) {
    if (typeof value !== type) throw invalid(name, `of type ${type}`);
}

function checkListener(fn: unknown) {
    if (typeof fn !== "function") throw invalid("listener", "a function");
}

function checkNumber(value: any, name: string, min = 0, int?: boolean) {
    check(value, name, "number");
    if (value >= min && !(int && value % 1)) return;
    const message = `The value of "${name}" is out of range`;
    throw nodeError(RangeError, "ERR_OUT_OF_RANGE", message);
}

function checkSignal(signal: any, name: string) {
    if (signal === undefined || "aborted" in Object(signal)) return;
    throw invalid(name, "an AbortSignal");
}

// the options of once and on: an AbortError for an aborted signal
function checkOptions(options: any) {
    if (!options || typeof options !== "object") {
        throw invalid("options", "an object");
    }
    checkSignal(options.signal, "options.signal");
    if (options.signal?.aborted) throw abortError(options.signal);
}

// EventEmitter

function EventEmitter(this: Emitter, opts?: Options) {
    (EventEmitter as any).init.call(this, opts);
}

function init(this: Emitter, opts?: Options) {
    const events = this._events;
    if (!events || events === Object.getPrototypeOf(this)._events) {
        this._events = Object.create(null);
        this._eventsCount = 0;
    }
    this._maxListeners ||= undefined;
    const capture = opts?.captureRejections;
    if (capture) check(capture, "options.captureRejections", "boolean");
    this[kCapture] = capture || proto[kCapture];
}

const proto = EventEmitter.prototype;

function getMax(ee: Emitter) {
    return ee._maxListeners ?? defaultMax;
}

// captureRejections: a listener's rejected promise goes to
// [Symbol.for('nodejs.rejection')] if the emitter has one, else to 'error'
function addCatch(ee: Emitter, promise: any, type: Name, args: any[]) {
    try {
        if (typeof promise.then !== "function") return;
        promise.then(undefined, (err: unknown) =>
            queueMicrotask(() => rejected(ee, err, type, args))
        );
    } catch (err) {
        ee.emit("error", err);
    }
}

function rejected(ee: Emitter, err: unknown, type: Name, args: any[]) {
    if (typeof ee[kRejection] === "function") {
        return ee[kRejection](err, type, ...args);
    }
    // no capture while emitting: a rejecting 'error' listener would loop
    const capture = ee[kCapture];
    try {
        ee[kCapture] = false;
        ee.emit("error", err);
    } finally {
        ee[kCapture] = capture;
    }
}

function unhandled(er: unknown) {
    if (er instanceof Error) return er;
    const message = `Unhandled error. (${String(er)})`;
    const err = nodeError(Error, "ERR_UNHANDLED_ERROR", message);
    return Object.assign(err, { context: er });
}

function emit(this: Emitter, type: Name, ...args: any[]): boolean {
    const events = this._events;
    if (type === "error") {
        if (events?.[errorMonitor]) this.emit(errorMonitor, ...args);
        if (!events?.error) throw unhandled(args[0]); // Unhandled 'error' event
    } else if (events === undefined) {
        return false;
    }

    const handler = events[type];
    if (handler === undefined) return false;
    if (typeof handler === "function") {
        // JavaScriptCore runs a call with its arguments spelled out several
        // times faster than an apply, V8 about as fast
        const result =
            args.length === 0
                ? handler.call(this)
                : args.length === 1
                  ? handler.call(this, args[0])
                  : handler.apply(this, args);
        if (result != null && this[kCapture]) {
            addCatch(this, result, type, args);
        }
    } else {
        emitList(this, handler, type, args);
    }
    return true;
}

// a copy of the list: the listeners a listener adds or removes wait for the
// next emit
function emitList(ee: Emitter, handler: Fn[], type: Name, args: any[]) {
    const list = handler.slice();
    const one = args.length === 1;
    for (let i = 0; i < list.length; ++i) {
        const result = one
            ? list[i].call(ee, args[0])
            : list[i].apply(ee, args);
        if (result != null && ee[kCapture]) addCatch(ee, result, type, args);
    }
}

function warn(ee: Emitter, type: Name, count: number, max: number) {
    const name = ee.constructor.name;
    const warning = Object.assign(
        new Error(
            `Possible EventEmitter memory leak detected. ${count} ${String(type)} listeners added to [${name}]. MaxListeners is ${max}. Use emitter.setMaxListeners() to increase limit`
        ),
        { name: "MaxListenersExceededWarning", emitter: ee, type, count }
    );
    const process = (globalThis as any).process;
    if (process?.emitWarning) process.emitWarning(warning);
    else console.warn(warning);
}

function _addListener(ee: Emitter, type: Name, fn: Fn, prepend: boolean) {
    checkListener(fn);
    let events = ee._events;
    let list: Fn | List;
    if (events === undefined) {
        events = ee._events = Object.create(null);
        ee._eventsCount = 0;
    } else {
        if (events.newListener !== undefined) {
            ee.emit("newListener", type, fn.listener ?? fn);
            events = ee._events;
        }
        list = events[type];
    }

    if (list === undefined) {
        events[type] = fn;
        ++ee._eventsCount;
        return ee;
    }
    if (typeof list === "function") {
        list = events[type] = prepend ? [fn, list] : [list, fn];
    } else if (prepend) {
        list.unshift(fn);
    } else {
        list.push(fn);
    }
    const max = getMax(ee);
    if (max > 0 && list.length > max && !list.warned) {
        list.warned = true;
        warn(ee, type, list.length, max);
    }
    return ee;
}

function addListener(this: Emitter, type: Name, fn: Fn) {
    return _addListener(this, type, fn, false);
}

function prependListener(this: Emitter, type: Name, fn: Fn) {
    return _addListener(this, type, fn, true);
}

// a closure, not Node's bound onceWrapper: JavaScriptCore creates and calls
// it faster
function onceWrap(ee: Emitter, type: Name, fn: Fn) {
    let fired = false;
    function wrapped(this: unknown) {
        if (fired) return;
        ee.removeListener(type, wrapped);
        fired = true;
        if (arguments.length === 0) return fn.call(ee);
        return fn.apply(ee, arguments as unknown as any[]);
    }
    wrapped.listener = fn;
    return wrapped as Fn;
}

function prependOnceListener(this: Emitter, type: Name, fn: Fn) {
    checkListener(fn);
    return _addListener(this, type, onceWrap(this, type, fn), true);
}

function matches(l: Fn, fn: Fn) {
    return l === fn || l.listener === fn;
}

function removeListener(this: Emitter, type: Name, fn: Fn) {
    checkListener(fn);
    const events = this._events;
    if (events === undefined) return this;
    const list = events[type];
    if (list === undefined) return this;

    if (typeof list === "function") {
        if (list !== fn && list.listener !== fn) return this;
        // down to no listener: none for removeListener either
        if (--this._eventsCount === 0) {
            this._events = Object.create(null);
            return this;
        }
        delete events[type];
        fn = list.listener || fn;
    } else {
        // the last added copy
        let i = list.length;
        while (--i >= 0 && !matches(list[i], fn));
        if (i < 0) return this;
        list.splice(i, 1);
        if (list.length === 1) events[type] = list[0];
    }
    if (events.removeListener) this.emit("removeListener", type, fn);
    return this;
}

function removeAllListeners(this: Emitter, type?: Name) {
    const events = this._events;
    if (arguments.length > 0) {
        // LIFO order
        for (const fn of rawListeners.call(this, type).reverse()) {
            this.removeListener(type, fn);
        }
    } else if (events) {
        // removeListener for every listener, its own listeners last
        if (events.removeListener) {
            for (const key of Reflect.ownKeys(events)) {
                if (key !== "removeListener") this.removeAllListeners(key);
            }
            this.removeAllListeners("removeListener");
        }
        this._events = Object.create(null);
        this._eventsCount = 0;
    }
    return this;
}

function rawListeners(this: Emitter, type: Name): Fn[] {
    return [].concat(this._events?.[type] ?? []);
}

function listeners(this: Emitter, type: Name) {
    return rawListeners.call(this, type).map((l: Fn) => l.listener || l);
}

function eventNames(this: Emitter) {
    return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
}

function countListeners(this: Emitter, type: Name, fn?: Fn) {
    const list = this._events?.[type];
    if (fn == null) return typeof list === "function" ? 1 : (list?.length ?? 0);
    return rawListeners.call(this, type).filter((l) => matches(l, fn)).length;
}

function setMax(this: Emitter, n: number) {
    checkNumber(n, "n");
    this._maxListeners = n;
    return this;
}

// statics

function listen(ee: any, name: Name, fn: Fn, once?: boolean) {
    if (typeof ee.on !== "function") {
        if (!ee.addEventListener) throw notEmitter();
        ee.addEventListener(name, fn, { once });
    } else if (once) ee.once(name, fn);
    else ee.on(name, fn);
}

function unlisten(ee: any, name: Name, fn: Fn) {
    if (typeof ee.removeListener === "function") ee.removeListener(name, fn);
    else if (ee.removeEventListener) ee.removeEventListener(name, fn);
    else throw notEmitter();
}

// Node's once is an async function: a validation error rejects, it does
// not throw
function once(ee: any, name: Name, options?: { signal?: AbortSignal }) {
    const signal = options?.signal;
    try {
        if (options !== undefined) checkOptions(options);
    } catch (e) {
        return Promise.reject(e);
    }
    return new Promise<any[]>((resolve, reject) => {
        let abort: () => void;
        const onError = (err: unknown) => {
            ee.removeListener(name, resolver);
            if (abort) signal.removeEventListener("abort", abort);
            reject(err);
        };
        const resolver = (...args: any[]) => {
            if (typeof ee.removeListener === "function") {
                ee.removeListener("error", onError);
            }
            if (abort) signal.removeEventListener("abort", abort);
            resolve(args);
        };
        listen(ee, name, resolver, true);
        // EventTargets have no 'error' semantics
        if (name !== "error" && ee.once) ee.once("error", onError);
        if (signal) {
            abort = () => {
                unlisten(ee, name, resolver);
                unlisten(ee, "error", onError);
                reject(abortError(signal));
            };
            signal.addEventListener("abort", abort, { once: true });
        }
    });
}

type OnOptions = {
    signal?: AbortSignal;
    close?: Name[];
    highWaterMark?: number;
    highWatermark?: number;
    lowWaterMark?: number;
    lowWatermark?: number;
};

// An async generator over the events the listeners queue: they are added
// at the call, the generator runs from the first next(). The emitter is
// paused above highWaterMark queued events and resumed under lowWaterMark
// (a stream's pause and resume).
function on(ee: any, event: Name, options: OnOptions = {}) {
    checkOptions(options);
    const max = Number.MAX_SAFE_INTEGER;
    const high = options.highWaterMark ?? options.highWatermark ?? max;
    const low = options.lowWaterMark ?? options.lowWatermark ?? 1;
    checkNumber(high, "options.highWaterMark", 1, true);
    checkNumber(low, "options.lowWaterMark", 1, true);

    const signal = options.signal;
    const queue: any[][] = [];
    let error: unknown = null;
    let finished = false;
    let paused = false;
    // resolves the read waiting for an event
    let wake = () => {};

    const done = () => {
        signal?.removeEventListener("abort", abort);
        for (const [name, fn] of added) unlisten(ee, name, fn);
        finished = true;
        wake();
    };
    const fail = (err: unknown) => {
        error = err;
        done();
    };
    const abort = () => fail(abortError(signal));
    const onEvent = (...args: any[]) => {
        if (queue.push(args) > high && !paused) {
            paused = true;
            ee.pause();
        }
        wake();
    };
    const added: [Name, Fn][] = [[event, onEvent]];
    if (event !== "error" && ee.on) added.push(["error", fail]);
    for (const name of options.close ?? []) added.push([name, done]);
    for (const [name, fn] of added) listen(ee, name, fn);
    signal?.addEventListener("abort", abort, { once: true });

    async function* read() {
        try {
            for (;;) {
                if (queue.length) {
                    if (paused && queue.length <= low) {
                        ee.resume();
                        paused = false;
                    }
                    yield queue.shift();
                } else if (error) {
                    throw error;
                } else if (finished) {
                    return;
                } else {
                    await new Promise<void>((resolve) => (wake = resolve));
                }
            }
        } finally {
            done();
        }
    }
    const iterator = read();
    // Node's return() and throw() end a read waiting for an event too
    const end = iterator.return;
    iterator.return = (value?: any) => {
        done();
        return end.call(iterator, value);
    };
    iterator.throw = (err: unknown): any => {
        if (!(err instanceof Error)) throw invalid("error", "an Error");
        fail(err);
    };
    return iterator;
}

function notEmitter() {
    return invalid("emitter", "an EventEmitter or EventTarget");
}

// an EventEmitter's method, or for an EventTarget, the value (the webview's
// listener lists are not readable)
function forTarget(ee: any, method: string, arg: unknown, value: unknown) {
    if (typeof ee?.[method] === "function") return ee[method](arg);
    if (ee instanceof EventTarget) return value;
    throw notEmitter();
}

function getEventListeners(ee: any, type: Name) {
    return forTarget(ee, "listeners", type, []);
}

function getMaxListeners(ee: any) {
    return forTarget(ee, "getMaxListeners", 0, ee?.[kMax] ?? defaultMax);
}

// deprecated (DEP0033)
function listenerCount(ee: any, type: Name) {
    return forTarget(ee, "listenerCount", type, 0);
}

function setMaxListeners(n = defaultMax, ...targets: any[]) {
    checkNumber(n, "n");
    if (targets.length === 0) defaultMax = n;
    for (const target of targets) {
        if (forTarget(target, "setMaxListeners", n, target) === target) {
            target[kMax] = n;
        }
    }
}

function addAbortListener(signal: AbortSignal, fn: () => void): Disposable {
    checkSignal(signal ?? null, "signal");
    checkListener(fn);
    if (signal.aborted) queueMicrotask(fn);
    else signal.addEventListener("abort", fn, { once: true });
    const dispose = () => signal.removeEventListener("abort", fn);
    return { [kDispose]: dispose } as any;
}

// no async_hooks in the webview: Node's surface with no async context to
// carry
class EventEmitterAsyncResource extends (EventEmitter as any) {
    asyncId = -1;
    triggerAsyncId = -1;
    asyncResource = { eventEmitter: this };
    constructor(options?: string | (Options & { name?: string })) {
        const named = typeof options === "string";
        if (!named && new.target === EventEmitterAsyncResource) {
            check(options?.name, "options.name", "string");
        }
        super(named ? undefined : options);
    }
    emitDestroy() {}
}

const usingDomains = false;

// the prototype and the statics, in a function for esbuild to hoist
function install() {
    Object.assign(proto, {
        _events: undefined,
        _eventsCount: 0,
        _maxListeners: undefined,
        [kCapture]: false,
        setMaxListeners: setMax,
        getMaxListeners() {
            return getMax(this);
        },
        emit,
        addListener,
        on: addListener,
        prependListener,
        once(this: Emitter, type: Name, fn: Fn) {
            checkListener(fn);
            this.on(type, onceWrap(this, type, fn));
            return this;
        },
        prependOnceListener,
        removeListener,
        off: removeListener,
        removeAllListeners,
        listeners,
        rawListeners,
        listenerCount: countListeners,
        eventNames
    });
    // the accessors (enumerable, as in Node) and the functions
    const statics = {
        get defaultMaxListeners() {
            return defaultMax;
        },
        set defaultMaxListeners(n: number) {
            checkNumber(n, "defaultMaxListeners");
            defaultMax = n;
        },
        get captureRejections() {
            return captureRejections;
        },
        set captureRejections(value: boolean) {
            check(value, "captureRejections", "boolean");
            proto[kCapture] = captureRejections = value;
        },
        addAbortListener,
        once,
        on,
        getEventListeners,
        getMaxListeners,
        listenerCount,
        EventEmitter,
        usingDomains,
        captureRejectionSymbol: kRejection,
        EventEmitterAsyncResource,
        errorMonitor,
        setMaxListeners,
        init
    };
    const descriptors = Object.getOwnPropertyDescriptors(statics);
    Object.defineProperties(EventEmitter, descriptors);
}
install();

// typed as Node's for the importers of this file
const Exported = EventEmitter as unknown as typeof NodeEvents.EventEmitter &
    typeof NodeEvents;

export {
    Exported as EventEmitter,
    Exported as default,
    Exported as "module.exports",
    addAbortListener,
    once,
    on,
    getEventListeners,
    getMaxListeners,
    setMaxListeners,
    listenerCount,
    usingDomains,
    kRejection as captureRejectionSymbol,
    captureRejections,
    errorMonitor,
    EventEmitterAsyncResource,
    defaultMax as defaultMaxListeners,
    init
};
