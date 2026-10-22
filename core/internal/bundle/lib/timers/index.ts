export const setTimeout = globalThis.setTimeout.bind(globalThis);
export const clearTimeout = globalThis.clearTimeout.bind(globalThis);
export const setInterval = globalThis.setInterval.bind(globalThis);
export const clearInterval = globalThis.clearInterval.bind(globalThis);

// setImmediate where there is none (pages, workers): a message to a channel
// of our own, a turn of the event loop. A timer of 0 waits at least 1 ms in
// Node and 4 ms once nested in a browser, and drivers defer per write with
// setImmediate (node-redis uncorks its socket in one, per command). Node's
// own is kept: it replaced it in apps run by fullstacked --file as soon as
// something imported "timers".
if (typeof globalThis.setImmediate !== "function") {
    const immediates = new Map<number, () => void>();
    let nextImmediate = 1;
    const channel =
        typeof MessageChannel === "function" ? new MessageChannel() : null;
    if (channel) {
        channel.port1.onmessage = (e: MessageEvent<number>) => {
            const run = immediates.get(e.data);
            immediates.delete(e.data);
            run?.();
        };
        // a port that listens keeps a Node process alive
        (channel.port1 as any).unref?.();
    }

    globalThis.setImmediate = ((
        callback: (...args: any[]) => void,
        ...args: any[]
    ) => {
        if (!channel) {
            return setTimeout(() => callback(...args), 0);
        }
        const id = nextImmediate++;
        immediates.set(id, () => callback(...args));
        channel.port2.postMessage(id);
        return id;
    }) as any;

    globalThis.clearImmediate = ((id: any) => {
        if (channel) {
            immediates.delete(id);
        } else {
            clearTimeout(id);
        }
    }) as any;
}

export const setImmediate = globalThis.setImmediate.bind(globalThis);
export const clearImmediate = globalThis.clearImmediate.bind(globalThis);

export * from "./promises.ts";
