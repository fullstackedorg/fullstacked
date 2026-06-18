import * as c from "./index.js";
export * from "./index.js";

export const crypto: any = c.default;
export const getCurves = () => [];
crypto.getCurves = getCurves;

export function randomUUID(): string {
    const parentCrypto = c.default || c;
    if (
        parentCrypto &&
        typeof parentCrypto.randomUUID === "function" &&
        parentCrypto.randomUUID !== randomUUID
    ) {
        return parentCrypto.randomUUID();
    }

    const getRandomBytes = (size: number): Uint8Array => {
        const bytes = new Uint8Array(size);
        if (
            typeof globalThis.crypto !== "undefined" &&
            typeof globalThis.crypto.getRandomValues === "function"
        ) {
            globalThis.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < size; i++) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }
        return bytes;
    };

    const bytes = getRandomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex: string[] = [];
    for (let i = 0; i < 16; i++) {
        hex.push(bytes[i].toString(16).padStart(2, "0"));
    }

    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join("")
    ].join("-");
}

crypto.randomUUID = randomUUID;

export default crypto;
