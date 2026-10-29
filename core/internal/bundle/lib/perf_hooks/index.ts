const universal = typeof globalThis !== "undefined" ? globalThis : global;
export const performance = universal.performance;
export const perf_hooks = { performance };
export default perf_hooks;
