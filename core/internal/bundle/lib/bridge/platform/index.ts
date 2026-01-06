export default {
    ready: new Promise<void>((res) => res()),
    get ctx() {
        return globalThis.ctxId;
    },
    Async: (payload: ArrayBuffer) =>
        globalThis.bridges.Async(payload) as Promise<ArrayBuffer>,
    Sync: (payload: ArrayBuffer) =>
        globalThis.bridges.Sync(payload) as ArrayBuffer,
    GetResponseSync: null as Function
};
