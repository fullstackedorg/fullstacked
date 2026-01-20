// https://nodejs.org/api/timers.html#timers-promises-api

export function setTimeout(delay: number, value?: any) {
    return new Promise<typeof value>((resolve) =>
        globalThis.setTimeout(() => resolve(value), delay)
    );
}

export async function* setInterval(delay: number, value?: any) {
    while (true) {
        yield setTimeout(delay, value);
    }
}

export default {
    setTimeout,
    setInterval
};
