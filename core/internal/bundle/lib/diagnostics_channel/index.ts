// node:diagnostics_channel (Node 22), improvements/shim/plan.md 5.4.
//
// Channels live as long as the runtime (Node holds the inactive ones
// weakly; names are static in practice). There is no AsyncLocalStorage in
// the webview: bindStore takes any store with Node's `run(context, fn)`,
// and runStores with no store bound publishes and runs the function.

import type * as NodeDc from "node:diagnostics_channel";

type ChannelName = string | symbol;
type Subscriber = (message: unknown, name: ChannelName) => void;
type Store = { run<R>(context: unknown, fn: () => R): R };
type Transform = (message: unknown) => unknown;
type Context = { result?: unknown; error?: unknown; [key: string]: unknown };

function invalidArgType(name: string, expected: string, value: unknown) {
    const error = new TypeError(
        `The "${name}" argument must be ${expected}. Received ${
            typeof value === "function" ? "function" : typeof value
        }`
    ) as TypeError & { code: string };
    error.code = "ERR_INVALID_ARG_TYPE";
    return error;
}

function validateFunction(value: unknown, name: string) {
    if (typeof value !== "function") {
        throw invalidArgType(name, "of type function", value);
    }
}

// Node rethrows a subscriber's error on the next tick, as uncaught
function reportAsync(error: unknown) {
    queueMicrotask(() => {
        throw error;
    });
}

const channels = new Map<ChannelName, Channel>();

class Channel {
    readonly name: ChannelName;
    // replaced, never mutated: a publish runs on the subscribers it started
    // with
    _subscribers: Subscriber[] = [];
    _stores: Map<Store, Transform> = undefined;

    constructor(name: ChannelName) {
        this.name = name;
        channels.set(name, this);
    }

    get hasSubscribers() {
        return this._subscribers.length > 0 || this._stores?.size > 0;
    }

    subscribe(subscription: Subscriber) {
        validateFunction(subscription, "subscription");
        this._subscribers = [...this._subscribers, subscription];
    }

    unsubscribe(subscription: Subscriber) {
        const index = this._subscribers.indexOf(subscription);
        if (index === -1) return false;
        const subscribers = this._subscribers.slice();
        subscribers.splice(index, 1);
        this._subscribers = subscribers;
        return true;
    }

    bindStore(store: Store, transform?: Transform) {
        (this._stores ??= new Map()).set(store, transform);
    }

    unbindStore(store: Store) {
        return this._stores?.delete(store) ?? false;
    }

    publish(data: unknown) {
        const subscribers = this._subscribers;
        for (let i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](data, this.name);
            } catch (error) {
                reportAsync(error);
            }
        }
    }

    runStores<A extends any[], R>(
        data: unknown,
        fn: (...args: A) => R,
        thisArg?: unknown,
        ...args: A
    ): R {
        if (!this.hasSubscribers) return fn.apply(thisArg, args);
        let run = () => {
            this.publish(data);
            return fn.apply(thisArg, args);
        };
        if (this._stores) {
            for (const [store, transform] of this._stores) {
                const next = run;
                run = () => {
                    let context: unknown;
                    try {
                        context = transform ? transform(data) : data;
                    } catch (error) {
                        reportAsync(error);
                        return next();
                    }
                    return store.run(context, next);
                };
            }
        }
        return run();
    }
}

function channel(name: ChannelName): Channel {
    const existing = channels.get(name);
    if (existing) return existing;
    if (typeof name !== "string" && typeof name !== "symbol") {
        throw invalidArgType("channel", "one of type string or symbol", name);
    }
    return new Channel(name);
}

function hasSubscribers(name: ChannelName) {
    return channels.get(name)?.hasSubscribers ?? false;
}

function subscribe(name: ChannelName, subscription: Subscriber) {
    return channel(name).subscribe(subscription);
}

function unsubscribe(name: ChannelName, subscription: Subscriber) {
    return channel(name).unsubscribe(subscription);
}

const traceEvents = [
    "start",
    "end",
    "asyncStart",
    "asyncEnd",
    "error"
] as const;
type TraceEvent = (typeof traceEvents)[number];
type TraceHandlers = Partial<Record<TraceEvent, Subscriber>>;

function tracingChannelFrom(
    nameOrChannels: string | Partial<Record<TraceEvent, Channel>>,
    name: TraceEvent
) {
    if (typeof nameOrChannels === "string") {
        return channel(`tracing:${nameOrChannels}:${name}`);
    }
    if (typeof nameOrChannels === "object" && nameOrChannels !== null) {
        const ch = nameOrChannels[name];
        if (!(ch instanceof Channel)) {
            throw invalidArgType(
                `nameOrChannels.${name}`,
                "an instance of Channel",
                ch
            );
        }
        return ch;
    }
    throw invalidArgType(
        "nameOrChannels",
        "of type string or an instance of TracingChannel or Object",
        nameOrChannels
    );
}

class TracingChannel {
    declare readonly start: Channel;
    declare readonly end: Channel;
    declare readonly asyncStart: Channel;
    declare readonly asyncEnd: Channel;
    declare readonly error: Channel;

    constructor(nameOrChannels: string | Partial<Record<TraceEvent, Channel>>) {
        for (const name of traceEvents) {
            Object.defineProperty(this, name, {
                value: tracingChannelFrom(nameOrChannels, name)
            });
        }
    }

    get hasSubscribers() {
        return (
            this.start.hasSubscribers ||
            this.end.hasSubscribers ||
            this.asyncStart.hasSubscribers ||
            this.asyncEnd.hasSubscribers ||
            this.error.hasSubscribers
        );
    }

    subscribe(handlers: TraceHandlers) {
        for (const name of traceEvents) {
            if (handlers[name]) this[name].subscribe(handlers[name]);
        }
    }

    unsubscribe(handlers: TraceHandlers) {
        let done = true;
        for (const name of traceEvents) {
            if (handlers[name] && !this[name].unsubscribe(handlers[name])) {
                done = false;
            }
        }
        return done;
    }

    traceSync<R>(
        fn: (...args: any[]) => R,
        context: Context = {},
        thisArg?: unknown,
        ...args: any[]
    ): R {
        if (!this.hasSubscribers) return fn.apply(thisArg, args);
        const { start, end, error } = this;
        return start.runStores(context, () => {
            try {
                const result = fn.apply(thisArg, args);
                context.result = result;
                return result;
            } catch (err) {
                context.error = err;
                error.publish(context);
                throw err;
            } finally {
                end.publish(context);
            }
        });
    }

    tracePromise<R>(
        fn: (...args: any[]) => PromiseLike<R>,
        context: Context = {},
        thisArg?: unknown,
        ...args: any[]
    ): Promise<R> {
        if (!this.hasSubscribers) return fn.apply(thisArg, args) as Promise<R>;
        const { start, end, asyncStart, asyncEnd, error } = this;
        const reject = (err: unknown) => {
            context.error = err;
            error.publish(context);
            asyncStart.publish(context);
            asyncEnd.publish(context);
            return Promise.reject(err);
        };
        const resolve = (result: R) => {
            context.result = result;
            asyncStart.publish(context);
            asyncEnd.publish(context);
            return result;
        };
        return start.runStores(context, () => {
            try {
                let promise = fn.apply(thisArg, args);
                // thenables become native promises
                if (!(promise instanceof Promise)) {
                    promise = Promise.resolve(promise);
                }
                return (promise as Promise<R>).then(resolve, reject);
            } catch (err) {
                context.error = err;
                error.publish(context);
                throw err;
            } finally {
                end.publish(context);
            }
        });
    }

    traceCallback<R>(
        fn: (...args: any[]) => R,
        position = -1,
        context: Context = {},
        thisArg?: unknown,
        ...args: any[]
    ): R {
        if (!this.hasSubscribers) return fn.apply(thisArg, args);
        const { start, end, asyncStart, asyncEnd, error } = this;
        const callback = args.at(position);
        validateFunction(callback, "callback");
        args.splice(
            position,
            1,
            function wrappedCallback(
                this: unknown,
                err: unknown,
                res: unknown
            ) {
                if (err) {
                    context.error = err;
                    error.publish(context);
                } else {
                    context.result = res;
                }
                // runStores here enables manual context failure recovery
                asyncStart.runStores(context, () => {
                    try {
                        return callback.apply(this, arguments);
                    } finally {
                        asyncEnd.publish(context);
                    }
                });
            }
        );
        return start.runStores(context, () => {
            try {
                return fn.apply(thisArg, args);
            } catch (err) {
                context.error = err;
                error.publish(context);
                throw err;
            } finally {
                end.publish(context);
            }
        });
    }
}

function tracingChannel(
    nameOrChannels: string | Partial<Record<TraceEvent, Channel>>
) {
    return new TracingChannel(nameOrChannels);
}

const dc = {
    channel,
    hasSubscribers,
    subscribe,
    tracingChannel,
    unsubscribe,
    Channel
};

const exported = dc as unknown as typeof NodeDc;

export {
    channel,
    hasSubscribers,
    subscribe,
    tracingChannel,
    unsubscribe,
    Channel,
    exported as default,
    exported as "module.exports"
};
