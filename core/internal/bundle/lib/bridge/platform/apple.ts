import type { PlatformBridge } from "./index.ts";
import { toByteArray } from "../base64.ts";
import { isWorker } from "../isWorker.ts";
import { readFrameStream } from "../frames.ts";
import { postCall, postSync, relayCall } from "./transport.ts";

const clipboardResponsePromises = new Map<number, (response: string) => void>();

export async function BridgeAppleInit(): Promise<PlatformBridge> {
    const ctx = await (await fetch("/ctx")).json();

    if (!isWorker) {
        globalThis.fullstacked.exit = () =>
            globalThis.webkit.messageHandlers.exit.postMessage("");

        globalThis.fullstacked.open = (ctx: number) =>
            globalThis.webkit.messageHandlers.open.postMessage(ctx);

        if (globalThis.webkit.messageHandlers.clipboard) {
            const td = new TextDecoder();
            globalThis.fullstacked.clipboard.respondPaste = (
                id: number,
                responseBase64: string
            ) => {
                const promise = clipboardResponsePromises.get(id);
                promise?.(td.decode(toByteArray(responseBase64)));
                clipboardResponsePromises.delete(id);
            };

            globalThis.fullstacked.clipboard.paste = () => {
                const id = Math.floor(Math.random() * 1000000);
                return new Promise<string>((resolve) => {
                    clipboardResponsePromises.set(id, resolve);
                    globalThis.webkit.messageHandlers.clipboard.postMessage(
                        id.toString()
                    );
                });
            };

            globalThis.fullstacked.clipboard.copy = (text: string) => {
                globalThis.webkit.messageHandlers.clipboard.postMessage({
                    action: "copy",
                    text
                });
            };
        }

        if (globalThis.webkit.messageHandlers.resize) {
            const resizeResponsePromises: ((size: string) => void)[] = [];

            globalThis.fullstacked.window.respondGetSize = function (
                response: string
            ) {
                const resolve = resizeResponsePromises.shift();
                resolve?.(response);
            };

            globalThis.fullstacked.window.resize = function (size: string) {
                globalThis.webkit.messageHandlers.resize.postMessage(size);
            };

            globalThis.fullstacked.window.getSize = function () {
                return new Promise<string>((resolve) => {
                    resizeResponsePromises.push(resolve);
                    globalThis.webkit.messageHandlers.resize.postMessage("get");
                });
            };
        }
    }

    // stream data as binary frames, workers get theirs through the main thread
    if (!isWorker) {
        await readFrameStream();
    }

    return {
        ctx,
        Async: isWorker ? relayCall : postCall,
        Sync: postSync
    };
}
