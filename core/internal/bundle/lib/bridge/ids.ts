// Request ids are one byte in the call header. Hosts match responses to
// requests by id, so an id must not be reused while its call is in flight.
// Id 0 is never allocated, ids 1-255 are handed out round robin skipping
// the ones in flight, and async calls wait for a free id beyond 255 in flight.

const inFlight = new Uint8Array(256);
let inFlightCount = 0;
let lastId = 0;
const waiters: (() => void)[] = [];

export const MAX_IN_FLIGHT = 255;

export function tryAcquireId(): number | null {
    if (inFlightCount >= MAX_IN_FLIGHT) {
        return null;
    }

    let id = lastId;
    do {
        id = id === 255 ? 1 : id + 1;
    } while (inFlight[id] === 1);

    inFlight[id] = 1;
    inFlightCount++;
    lastId = id;
    return id;
}

// returns the id synchronously when one is free so the call is posted in
// the same tick, keeping the order of calls
export function acquireId(): number | Promise<number> {
    // keep the order of calls already waiting for an id
    const id = waiters.length === 0 ? tryAcquireId() : null;
    return id ?? waitForId();
}

async function waitForId() {
    let id: number | null = null;
    while (id === null) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        id = tryAcquireId();
    }
    return id;
}

export function releaseId(id: number) {
    if (inFlight[id] !== 1) {
        return;
    }
    inFlight[id] = 0;
    inFlightCount--;
    waiters.shift()?.();
}
