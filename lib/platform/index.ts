export enum Platform {
    NODE = "node",
    APPLE = "apple",
    ANDROID = "android",
    DOCKER = "docker",
    WINDOWS = "windows",
    WASM = "wasm"
}

const platform = await (await fetch("/platform")).text();
export default platform;
