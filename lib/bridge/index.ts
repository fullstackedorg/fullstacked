import "../core_message";
import platform, { Platform } from "../platform";
import { BridgeAndroid } from "./platform/android";
import { BridgeApple, initRespondApple } from "./platform/apple";
import { BridgeLinux, initRespondLinux } from "./platform/linux";
import { BridgeNode, initCallbackNode } from "./platform/node";
import { BridgeWasm } from "./platform/wasm";
import { BridgeWindows, initRespondWindows } from "./platform/windows";

export type Bridge = (
    payload: Uint8Array,
    transformer?: (args: any) => any
) => Promise<any>;

export let bridge: Bridge;

switch (platform) {
    case Platform.NODE:
        bridge = BridgeNode;
        initCallbackNode();
        break;
    case Platform.APPLE:
        bridge = BridgeApple;
        initRespondApple();
        break;
    case Platform.ANDROID:
        bridge = BridgeAndroid;
        break;
    case Platform.WASM:
        bridge = BridgeWasm;
        break;
    case Platform.WINDOWS:
        bridge = BridgeWindows;
        initRespondWindows();
        break;
    case Platform.LINUX:
        bridge = BridgeLinux;
        initRespondLinux();
        break;
    case Platform.DOCKER:
        console.log("Bridge not yet implemented");
}

console.log("FullStacked");
bridge(new Uint8Array([0]));
