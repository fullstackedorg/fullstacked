export const setTimeout = globalThis.setTimeout.bind(globalThis);
export const clearTimeout = globalThis.clearTimeout.bind(globalThis);
export const setInterval = globalThis.setInterval.bind(globalThis);
export const clearInterval = globalThis.clearInterval.bind(globalThis);

globalThis.setImmediate = ((
    callback: (...args: any[]) => void,
    ...args: any[]
) => {
    setTimeout(() => callback(...args), 0);
}) as any;

export * from "./promises.ts";
