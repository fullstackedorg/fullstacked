// @ts-ignore
import b from "./index.js";
globalThis.Buffer = b.Buffer;

b.Buffer.prototype.latin1Slice = function (start: number, end: number) {
    return this.toString("latin1", start, end);
};
b.Buffer.prototype.utf8Slice = function (start: number, end: number) {
    return this.toString("utf8", start, end);
};
b.Buffer.prototype.utf8Write = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "utf8");
};
b.Buffer.prototype.base64Slice = function (start: number, end: number) {
    return this.toString("base64", start, end);
};

export * from "./index.js";
