export enum Platform {
    NODE = "node",
    APPLE = "apple",
    ANDROID = "android",
    DOCKER = "docker",
    WINDOWS = "windows",
    WASM = "wasm",
    LINUX_GTK = "linux-gtk",
    LINUX_QT = "linux-qt",
    ELECTRON = "electron"
}

const platform = await (await fetch("/platform")).text();
export default platform;
