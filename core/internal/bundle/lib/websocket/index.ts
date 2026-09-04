import { WebSocket as WebSocketModule } from "../@types/index.ts";
import { Connect } from "../@types/websocket.ts";
import type { Duplex } from "../bridge/duplex.ts";
import type { EventEmitter } from "../bridge/eventEmitter.ts";

const GlobalCloseEvent =
    typeof CloseEvent !== "undefined"
        ? CloseEvent
        : class CloseEvent extends Event {
              readonly code: number;
              readonly reason: string;
              readonly wasClean: boolean;
              constructor(type: string, eventInitDict?: CloseEventInit) {
                  super(type, eventInitDict);
                  this.code = eventInitDict?.code ?? 0;
                  this.reason = eventInitDict?.reason ?? "";
                  this.wasClean = eventInitDict?.wasClean ?? false;
              }
          };

export class WebSocketCore extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    readyState: number = WebSocketCore.CONNECTING;
    bufferedAmount: number = 0;
    protocol: string = "";
    extensions: string = "";
    binaryType: "blob" | "arraybuffer" = "blob";

    onopen: ((this: WebSocketCore, ev: Event) => any) | null = null;
    onerror: ((this: WebSocketCore, ev: Event) => any) | null = null;
    onclose: ((this: WebSocketCore, ev: CloseEvent) => any) | null = null;
    onmessage: ((this: WebSocketCore, ev: MessageEvent) => any) | null = null;

    #duplex: Duplex | null = null;
    #ee: EventEmitter<{
        open: [string];
        message: [string | Uint8Array, boolean];
        error: [string];
        close: [number, string, boolean];
    }> | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
        super();

        let parsedUrl: URL;
        try {
            if (url instanceof URL) {
                parsedUrl = url;
            } else if (typeof url === "string") {
                if (
                    url.startsWith("/") &&
                    typeof globalThis.location !== "undefined"
                ) {
                    const origin =
                        globalThis.location.origin ||
                        globalThis.location.href ||
                        "http://localhost";
                    parsedUrl = new URL(url, origin);
                    if (parsedUrl.protocol === "http:") {
                        parsedUrl.protocol = "ws:";
                    } else if (parsedUrl.protocol === "https:") {
                        parsedUrl.protocol = "wss:";
                    }
                } else {
                    parsedUrl = new URL(url);
                }
            } else {
                throw new Error("Invalid URL");
            }
        } catch {
            throw new DOMException(
                `The URL '${url}' is invalid.`,
                "SyntaxError"
            );
        }

        if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
            throw new DOMException(
                `The URL's scheme must be either 'ws' or 'wss'. '${parsedUrl.protocol}' is not allowed.`,
                "SyntaxError"
            );
        }

        this.url = parsedUrl.toString();

        let parsedProtocols: string[] = [];
        if (typeof protocols === "string") {
            parsedProtocols = [protocols];
        } else if (Array.isArray(protocols)) {
            parsedProtocols = [...protocols];
        }

        this.#init(parsedProtocols);
    }

    async #init(protocols: string[]) {
        try {
            this.#duplex = (await globalThis.fullstacked.bridge({
                mod: WebSocketModule,
                fn: Connect,
                data: [this.url, protocols]
            })) as Duplex;

            this.#ee = this.#duplex.eventEmitter();

            this.#ee.on("open", (selectedProtocol?: string) => {
                if (this.readyState === WebSocketCore.CONNECTING) {
                    this.readyState = WebSocketCore.OPEN;
                    this.protocol = selectedProtocol || "";
                    const event = new Event("open");
                    this.dispatchEvent(event);
                    this.onopen?.(event);
                }
            });

            this.#ee.on(
                "message",
                (data: string | Uint8Array, isBinary: boolean) => {
                    if (
                        this.readyState !== WebSocketCore.OPEN &&
                        this.readyState !== WebSocketCore.CLOSING
                    ) {
                        return;
                    }

                    let messageData: any = data;
                    if (isBinary && data instanceof Uint8Array) {
                        if (this.binaryType === "arraybuffer") {
                            messageData = data.buffer.slice(
                                data.byteOffset,
                                data.byteOffset + data.byteLength
                            );
                        } else {
                            messageData =
                                typeof Blob !== "undefined"
                                    ? new Blob([data as any])
                                    : data.buffer.slice(
                                          data.byteOffset,
                                          data.byteOffset + data.byteLength
                                      );
                        }
                    }

                    const event = new MessageEvent("message", {
                        data: messageData,
                        origin: this.url
                    });
                    this.dispatchEvent(event);
                    this.onmessage?.(event);
                }
            );

            this.#ee.on("error", (errorMsg: string) => {
                const event = new Event("error");
                (event as any).message = errorMsg;
                this.dispatchEvent(event);
                this.onerror?.(event);
            });

            this.#ee.on(
                "close",
                (code: number, reason: string, wasClean: boolean) => {
                    if (this.readyState === WebSocketCore.CLOSED) return;
                    this.readyState = WebSocketCore.CLOSED;
                    const event = new GlobalCloseEvent("close", {
                        code: code || 1000,
                        reason: reason || "",
                        wasClean: wasClean ?? code === 1000
                    });
                    this.dispatchEvent(event);
                    this.onclose?.(event);
                }
            );

            this.#duplex.on("close", () => {
                if (this.readyState !== WebSocketCore.CLOSED) {
                    this.readyState = WebSocketCore.CLOSED;
                    const event = new GlobalCloseEvent("close", {
                        code: 1006,
                        reason: "",
                        wasClean: false
                    });
                    this.dispatchEvent(event);
                    this.onclose?.(event);
                }
            });
        } catch (err: any) {
            queueMicrotask(() => {
                this.readyState = WebSocketCore.CLOSED;
                const errorEvent = new Event("error");
                (errorEvent as any).message = err?.message || String(err);
                this.dispatchEvent(errorEvent);
                this.onerror?.(errorEvent);

                const closeEvent = new GlobalCloseEvent("close", {
                    code: 1006,
                    reason: err?.message || String(err),
                    wasClean: false
                });
                this.dispatchEvent(closeEvent);
                this.onclose?.(closeEvent);
            });
        }
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (this.readyState === WebSocketCore.CONNECTING) {
            throw new DOMException(
                "WebSocket is still in CONNECTING state.",
                "InvalidStateError"
            );
        }

        if (this.readyState !== WebSocketCore.OPEN) {
            return;
        }

        if (typeof data === "string") {
            this.#duplex?.writeEvent("send", data, false);
        } else if (data instanceof Uint8Array) {
            this.#duplex?.writeEvent("send", data, true);
        } else if (data instanceof ArrayBuffer) {
            this.#duplex?.writeEvent("send", new Uint8Array(data), true);
        } else if (ArrayBuffer.isView(data)) {
            this.#duplex?.writeEvent(
                "send",
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                true
            );
        } else if (typeof Blob !== "undefined" && data instanceof Blob) {
            data.arrayBuffer().then((buf) => {
                if (this.readyState === WebSocketCore.OPEN) {
                    this.#duplex?.writeEvent("send", new Uint8Array(buf), true);
                }
            });
        } else {
            this.#duplex?.writeEvent("send", String(data), false);
        }
    }

    close(code?: number, reason?: string) {
        if (code !== undefined) {
            if (code !== 1000 && (code < 3000 || code > 4999)) {
                throw new DOMException(
                    `The code must be either 1000, or between 3000 and 4999. Received ${code}`,
                    "InvalidAccessError"
                );
            }
        }

        if (reason !== undefined) {
            const byteLength = new TextEncoder().encode(reason).byteLength;
            if (byteLength > 123) {
                throw new DOMException(
                    "The reason must not be longer than 123 bytes.",
                    "SyntaxError"
                );
            }
        }

        if (
            this.readyState === WebSocketCore.CLOSING ||
            this.readyState === WebSocketCore.CLOSED
        ) {
            return;
        }

        this.readyState = WebSocketCore.CLOSING;
        this.#duplex?.writeEvent("close", code ?? 1000, reason ?? "");
    }
}

export default WebSocketCore;
