// @ts-ignore
import b from "./index.js";
if (!globalThis.Buffer) {
    globalThis.Buffer = b.Buffer;
}

b.Buffer.prototype.asciiSlice = function (start: number, end: number) {
    return this.toString("ascii", start, end);
};
b.Buffer.prototype.latin1Slice = function (start: number, end: number) {
    return this.toString("latin1", start, end);
};
b.Buffer.prototype.utf8Slice = function (start: number, end: number) {
    return this.toString("utf8", start, end);
};
b.Buffer.prototype.base64Slice = function (start: number, end: number) {
    return this.toString("base64", start, end);
};
b.Buffer.prototype.base64urlSlice = function (start: number, end: number) {
    return this.toString("base64url", start, end);
};
b.Buffer.prototype.hexSlice = function (start: number, end: number) {
    return this.toString("hex", start, end);
};
b.Buffer.prototype.ucs2Slice = function (start: number, end: number) {
    return this.toString("ucs2", start, end);
};
b.Buffer.prototype.utf16leSlice = function (start: number, end: number) {
    return this.toString("utf16le", start, end);
};

b.Buffer.prototype.utf8Write = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "utf8");
};
b.Buffer.prototype.asciiWrite = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "ascii");
};
b.Buffer.prototype.latin1Write = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "latin1");
};
b.Buffer.prototype.binaryWrite = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "latin1");
};
b.Buffer.prototype.base64Write = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "base64");
};
b.Buffer.prototype.base64urlWrite = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "base64url");
};
b.Buffer.prototype.hexWrite = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "hex");
};
b.Buffer.prototype.ucs2Write = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "ucs2");
};
b.Buffer.prototype.utf16leWrite = function (
    string: string,
    offset: number,
    length: number
) {
    return this.write(string, offset, length, "utf16le");
};

export * from "./index.js";
