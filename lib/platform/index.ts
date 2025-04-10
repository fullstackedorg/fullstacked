export enum Platform {
    NODE = "node",
    APPLE = "apple",
    ANDROID = "android",
    DOCKER = "docker",
    WINDOWS = "windows",
    WASM = "wasm",
    LINUX = "linux"
}

const platform = await (await fetch("/platform")).text();
export default platform;
