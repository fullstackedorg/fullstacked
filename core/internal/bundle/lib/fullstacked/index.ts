import platformBridge from "../bridge/platform/index.ts";
try {
    await platformBridge.ready;
} catch (e) {
    console.log(e);
}
