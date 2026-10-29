import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import { Buffer } from "buffer";

export interface Key {
    sequence?: string;
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    code?: string;
}

export type Direction = -1 | 0 | 1;

export interface CursorPos {
    rows: number;
    cols: number;
}

export type CompleterResult = [string[], string];
export type Completer = (line: string) => CompleterResult;
export type AsyncCompleter = (
    line: string,
    callback: (err?: null | Error, result?: CompleterResult) => void
) => void;

export interface ReadLineOptions {
    input: any;
    output?: any;
    completer?: Completer | AsyncCompleter;
    terminal?: boolean;
    history?: string[];
    historySize?: number;
    removeHistoryDuplicates?: boolean;
    prompt?: string;
    crlfDelay?: number;
    escapeCodeTimeout?: number;
    tabSize?: number;
    signal?: AbortSignal;
}

const KEYPRESS_DECODER = Symbol.for("KEYPRESS_DECODER");

export function emitKeypressEvents(
    stream: any,
    readlineInterface?: Interface
): void {
    if (!stream || stream[KEYPRESS_DECODER]) return;
    stream[KEYPRESS_DECODER] = true;

    const decoder = new StringDecoder("utf8");

    stream.on("data", (chunk: any) => {
        if (stream.listenerCount("keypress") === 0) return;
        const str = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (!str) return;

        for (const [char, key] of parseKeys(str)) {
            stream.emit("keypress", char, key);
        }
    });
}

function* parseKeys(s: string): Generator<[string, Key]> {
    let i = 0;
    while (i < s.length) {
        const ch = s[i];

        if (ch === "\x1b") {
            if (i + 1 >= s.length) {
                yield [
                    "\x1b",
                    {
                        sequence: "\x1b",
                        name: "escape",
                        ctrl: false,
                        meta: false,
                        shift: false
                    }
                ];
                i++;
                continue;
            }

            const next = s[i + 1];

            if (next === "[" || next === "O") {
                let seqEnd = i + 2;
                while (seqEnd < s.length) {
                    const c = s[seqEnd];
                    if (
                        (c >= "A" && c <= "Z") ||
                        (c >= "a" && c <= "z") ||
                        c === "~"
                    ) {
                        seqEnd++;
                        break;
                    }
                    seqEnd++;
                }

                const seq = s.slice(i, seqEnd);
                i = seqEnd;
                const parsed = parseCsiOrSs3(seq);
                yield [parsed.sequence || seq, parsed];
                continue;
            }

            if (next === "\x1b") {
                yield [
                    "\x1b",
                    {
                        sequence: "\x1b\x1b",
                        name: "escape",
                        ctrl: false,
                        meta: true,
                        shift: false
                    }
                ];
                i += 2;
                continue;
            }

            const metaChar = s[i + 1];
            i += 2;
            const isUpper = metaChar >= "A" && metaChar <= "Z";
            yield [
                metaChar,
                {
                    sequence: "\x1b" + metaChar,
                    name: metaChar.toLowerCase(),
                    ctrl: false,
                    meta: true,
                    shift: isUpper
                }
            ];
            continue;
        }

        if (ch === "\r") {
            yield [
                "\r",
                {
                    sequence: "\r",
                    name: "return",
                    ctrl: false,
                    meta: false,
                    shift: false
                }
            ];
            i++;
            continue;
        }

        if (ch === "\n") {
            yield [
                "\n",
                {
                    sequence: "\n",
                    name: "enter",
                    ctrl: false,
                    meta: false,
                    shift: false
                }
            ];
            i++;
            continue;
        }

        if (ch === "\t") {
            yield [
                "\t",
                {
                    sequence: "\t",
                    name: "tab",
                    ctrl: false,
                    meta: false,
                    shift: false
                }
            ];
            i++;
            continue;
        }

        if (ch === "\x08" || ch === "\x7f") {
            yield [
                "\x7f",
                {
                    sequence: ch,
                    name: "backspace",
                    ctrl: false,
                    meta: false,
                    shift: false
                }
            ];
            i++;
            continue;
        }

        const code = ch.charCodeAt(0);
        if (code >= 1 && code <= 26) {
            const name = String.fromCharCode(code + 96);
            yield [
                ch,
                {
                    sequence: ch,
                    name,
                    ctrl: true,
                    meta: false,
                    shift: false
                }
            ];
            i++;
            continue;
        }

        const isUpper = ch >= "A" && ch <= "Z";
        yield [
            ch,
            {
                sequence: ch,
                name: ch.toLowerCase(),
                ctrl: false,
                meta: false,
                shift: isUpper
            }
        ];
        i++;
    }
}

function parseCsiOrSs3(seq: string): Key {
    const key: Key = {
        sequence: seq,
        name: undefined,
        ctrl: false,
        meta: false,
        shift: false
    };

    if (seq.startsWith("\x1bO")) {
        const cmd = seq.slice(2);
        switch (cmd) {
            case "A":
                key.name = "up";
                break;
            case "B":
                key.name = "down";
                break;
            case "C":
                key.name = "right";
                break;
            case "D":
                key.name = "left";
                break;
            case "E":
                key.name = "clear";
                break;
            case "F":
                key.name = "end";
                break;
            case "H":
                key.name = "home";
                break;
            case "P":
                key.name = "f1";
                break;
            case "Q":
                key.name = "f2";
                break;
            case "R":
                key.name = "f3";
                break;
            case "S":
                key.name = "f4";
                break;
        }
        return key;
    }

    if (seq.startsWith("\x1b[")) {
        const body = seq.slice(2);
        const lastChar = body[body.length - 1];
        const params = body.slice(0, -1).split(";");

        let mod = 1;
        if (params.length > 1) {
            mod = parseInt(params[1], 10) || 1;
        } else if (params.length === 1 && params[0].includes(",")) {
            mod = parseInt(params[0].split(",")[1], 10) || 1;
        }

        if (mod > 1) {
            const modFlags = mod - 1;
            key.shift = Boolean(modFlags & 1);
            key.meta = Boolean(modFlags & 2);
            key.ctrl = Boolean(modFlags & 4);
        }

        if (lastChar === "~") {
            const codeNum = parseInt(params[0], 10);
            switch (codeNum) {
                case 1:
                    key.name = "home";
                    break;
                case 2:
                    key.name = "insert";
                    break;
                case 3:
                    key.name = "delete";
                    break;
                case 4:
                    key.name = "end";
                    break;
                case 5:
                    key.name = "pageup";
                    break;
                case 6:
                    key.name = "pagedown";
                    break;
                case 7:
                    key.name = "home";
                    break;
                case 8:
                    key.name = "end";
                    break;
                case 11:
                    key.name = "f1";
                    break;
                case 12:
                    key.name = "f2";
                    break;
                case 13:
                    key.name = "f3";
                    break;
                case 14:
                    key.name = "f4";
                    break;
                case 15:
                    key.name = "f5";
                    break;
                case 17:
                    key.name = "f6";
                    break;
                case 18:
                    key.name = "f7";
                    break;
                case 19:
                    key.name = "f8";
                    break;
                case 20:
                    key.name = "f9";
                    break;
                case 21:
                    key.name = "f10";
                    break;
                case 23:
                    key.name = "f11";
                    break;
                case 24:
                    key.name = "f12";
                    break;
            }
        } else {
            switch (lastChar) {
                case "A":
                    key.name = "up";
                    break;
                case "B":
                    key.name = "down";
                    break;
                case "C":
                    key.name = "right";
                    break;
                case "D":
                    key.name = "left";
                    break;
                case "E":
                    key.name = "clear";
                    break;
                case "F":
                    key.name = "end";
                    break;
                case "H":
                    key.name = "home";
                    break;
                case "Z":
                    key.name = "tab";
                    key.shift = true;
                    break;
            }
        }
    }

    return key;
}

export function clearLine(
    stream: any,
    dir: Direction,
    callback?: () => void
): boolean {
    if (!stream) return true;
    let code = "\x1b[2K";
    if (dir < 0) {
        code = "\x1b[1K";
    } else if (dir > 0) {
        code = "\x1b[0K";
    }
    const ret = stream.write ? stream.write(code, callback) : true;
    if (!stream.write && callback) callback();
    return ret;
}

export function clearScreenDown(stream: any, callback?: () => void): boolean {
    if (!stream) return true;
    const ret = stream.write ? stream.write("\x1b[0J", callback) : true;
    if (!stream.write && callback) callback();
    return ret;
}

export function cursorTo(
    stream: any,
    x: number,
    y?: number | (() => void),
    callback?: () => void
): boolean {
    if (!stream) return true;
    let cb = callback;
    let posY = y;
    if (typeof posY === "function") {
        cb = posY;
        posY = undefined;
    }

    let code = "";
    if (typeof posY === "number") {
        code = `\x1b[${Math.floor(posY) + 1};${Math.floor(x) + 1}H`;
    } else {
        code = `\x1b[${Math.floor(x) + 1}G`;
    }

    const ret = stream.write ? stream.write(code, cb) : true;
    if (!stream.write && cb) cb();
    return ret;
}

export function moveCursor(
    stream: any,
    dx: number,
    dy?: number | (() => void),
    callback?: () => void
): boolean {
    if (!stream) return true;
    let cb = callback;
    let deltaY = typeof dy === "number" ? dy : 0;
    if (typeof dy === "function") {
        cb = dy;
        deltaY = 0;
    }

    let code = "";
    if (dx < 0) {
        code += `\x1b[${-dx}D`;
    } else if (dx > 0) {
        code += `\x1b[${dx}C`;
    }

    if (deltaY < 0) {
        code += `\x1b[${-deltaY}A`;
    } else if (deltaY > 0) {
        code += `\x1b[${deltaY}B`;
    }

    if (!code) {
        if (cb) cb();
        return true;
    }

    const ret = stream.write ? stream.write(code, cb) : true;
    if (!stream.write && cb) cb();
    return ret;
}

const activeInterfaces = new Set<Interface>();

export function getActiveInterfaces(): Interface[] {
    return Array.from(activeInterfaces);
}

export function waitForInterfaces(): Promise<void> {
    if (activeInterfaces.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const check = () => {
            if (activeInterfaces.size === 0) {
                resolve();
            } else {
                for (const rl of activeInterfaces) {
                    rl.once("close", check);
                }
            }
        };
        for (const rl of activeInterfaces) {
            rl.once("close", check);
        }
    });
}

export class Interface extends EventEmitter {
    readonly input: any;
    readonly output: any;
    readonly terminal: boolean;
    line: string = "";
    cursor: number = 0;
    history: string[] = [];
    historySize: number = 30;
    removeHistoryDuplicates: boolean = false;
    historyIndex: number = -1;
    crlfDelay: number = 100;
    escapeCodeTimeout: number = 500;
    tabSize: number = 8;
    completer?: Completer | AsyncCompleter;
    closed: boolean = false;
    paused: boolean = false;

    private _prompt: string = "> ";
    private _sawReturnAt: number = 0;
    private _crlfTimer: any = null;
    private _lineBuffer: string = "";
    private _decoder: StringDecoder;
    private _asyncQueue: Array<
        { value: string; done: false } | { value: undefined; done: true }
    > = [];
    private _asyncResolvers: Array<
        (item: { value: any; done: boolean }) => void
    > = [];
    private _pendingQuestion: {
        query: string;
        cb: (answer: string) => void;
        cleanUp?: () => void;
    } | null = null;
    private _oldRawMode: boolean = false;

    private _onDataListener: (chunk: any) => void;
    private _onEndListener: () => void;
    private _onCloseListener: () => void;
    private _onErrorListener: (err: any) => void;
    private _onKeypressListener: (char: string, key: Key) => void;

    constructor(
        inputOrOptions?: any,
        output?: any,
        completer?: Completer | AsyncCompleter,
        terminal?: boolean
    ) {
        super();
        activeInterfaces.add(this);

        let opts: ReadLineOptions;
        if (
            inputOrOptions &&
            typeof inputOrOptions === "object" &&
            !("on" in inputOrOptions) &&
            !("read" in inputOrOptions)
        ) {
            opts = inputOrOptions;
        } else {
            opts = {
                input: inputOrOptions,
                output,
                completer,
                terminal
            };
        }

        const globalProcess = (globalThis as any).process;
        this.input = opts.input || globalProcess?.stdin || new EventEmitter();
        this.output =
            opts.output ||
            (opts.output === null ? undefined : globalProcess?.stdout);
        this.terminal =
            opts.terminal !== undefined
                ? Boolean(opts.terminal)
                : Boolean(this.output && this.output.isTTY);

        if (opts.completer) this.completer = opts.completer;
        if (opts.history) this.history = [...opts.history];
        if (typeof opts.historySize === "number")
            this.historySize = opts.historySize;
        if (opts.removeHistoryDuplicates !== undefined)
            this.removeHistoryDuplicates = Boolean(
                opts.removeHistoryDuplicates
            );
        if (opts.prompt !== undefined) this._prompt = String(opts.prompt);
        if (typeof opts.crlfDelay === "number")
            this.crlfDelay = Math.max(100, opts.crlfDelay);
        if (opts.crlfDelay === Infinity) this.crlfDelay = Infinity;
        if (typeof opts.escapeCodeTimeout === "number")
            this.escapeCodeTimeout = opts.escapeCodeTimeout;
        if (typeof opts.tabSize === "number")
            this.tabSize = Math.max(1, opts.tabSize);

        this._decoder = new StringDecoder("utf8");

        this._onDataListener = (chunk: any) => this._onData(chunk);
        this._onEndListener = () => this._onEnd();
        this._onCloseListener = () => this.close();
        this._onErrorListener = (err: any) => this.emit("error", err);
        this._onKeypressListener = (char: string, key: Key) =>
            this._onKeypress(char, key);

        if (this.terminal) {
            emitKeypressEvents(this.input, this);
            if (
                this.input?.isTTY &&
                typeof this.input.setRawMode === "function"
            ) {
                this._oldRawMode = Boolean(this.input.isRaw);
                this.input.setRawMode(true);
            }
            this.input.on("keypress", this._onKeypressListener);
        } else {
            this.input.on("data", this._onDataListener);
        }

        this.input.on("end", this._onEndListener);
        this.input.on("close", this._onCloseListener);
        this.input.on("error", this._onErrorListener);
        this.input?.resume?.();

        if (opts.signal) {
            if (opts.signal.aborted) {
                this.close();
            } else {
                opts.signal.addEventListener("abort", () => this.close(), {
                    once: true
                });
            }
        }
    }

    getPrompt(): string {
        return this._prompt;
    }

    setPrompt(prompt: string): void {
        this._prompt = prompt;
    }

    prompt(preserveCursor?: boolean): void {
        if (this.closed) return;
        this.resume();
        if (!this.output) return;

        if (this.terminal) {
            if (!preserveCursor) {
                this.cursor = this.line.length;
            }
            this._refreshLine();
        } else {
            this.output.write(this._prompt);
        }
    }

    question(query: string, callback: (answer: string) => void): void;
    question(
        query: string,
        options: { signal?: AbortSignal },
        callback: (answer: string) => void
    ): void;
    question(
        query: string,
        optionsOrCallback: any,
        callback?: (answer: string) => void
    ): void {
        if (this.closed) {
            throw new Error("readline: Interface is closed");
        }

        let cb: (answer: string) => void;
        let signal: AbortSignal | undefined;

        if (typeof optionsOrCallback === "function") {
            cb = optionsOrCallback;
        } else {
            cb = callback!;
            signal = optionsOrCallback?.signal;
        }

        this.resume();

        if (signal?.aborted) {
            return;
        }

        const oldPrompt = this._prompt;
        this.setPrompt(query);

        const wrappedCb = (answer: string) => {
            this.setPrompt(oldPrompt);
            cb(answer);
        };

        let cleanUp: (() => void) | undefined;
        if (signal) {
            const onAbort = () => {
                if (this._pendingQuestion?.cb === wrappedCb) {
                    this._pendingQuestion = null;
                }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            cleanUp = () => signal.removeEventListener("abort", onAbort);
        }

        this._pendingQuestion = {
            query,
            cb: wrappedCb,
            cleanUp
        };

        if (this.output) {
            if (this.terminal) {
                this.prompt();
            } else {
                this.output.write(query);
            }
        }
    }

    pause(): this {
        if (!this.paused) {
            this.paused = true;
            if (
                this.terminal &&
                this.input?.isTTY &&
                typeof this.input.setRawMode === "function"
            ) {
                this.input.setRawMode(false);
            }
            this.input?.pause?.();
            this.emit("pause");
        }
        return this;
    }

    resume(): this {
        if (this.paused) {
            this.paused = false;
            if (
                this.terminal &&
                this.input?.isTTY &&
                typeof this.input.setRawMode === "function"
            ) {
                this.input.setRawMode(true);
            }
            this.input?.resume?.();
            this.emit("resume");
        }
        return this;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        activeInterfaces.delete(this);

        if (this._crlfTimer) {
            clearTimeout(this._crlfTimer);
            this._crlfTimer = null;
        }

        if (
            this.terminal &&
            this.input &&
            typeof this.input.setRawMode === "function"
        ) {
            this.input.setRawMode(Boolean(this._oldRawMode));
        }

        if (this.input) {
            this.input.removeListener?.("data", this._onDataListener);
            this.input.removeListener?.("keypress", this._onKeypressListener);
            this.input.removeListener?.("end", this._onEndListener);
            this.input.removeListener?.("close", this._onCloseListener);
            this.input.removeListener?.("error", this._onErrorListener);
            if (!this.paused) {
                this.input.pause?.();
            }
        }

        while (this._asyncResolvers.length > 0) {
            const resolve = this._asyncResolvers.shift()!;
            resolve({ value: undefined, done: true });
        }

        this.emit("close");
    }

    [Symbol.dispose](): void {
        this.close();
    }

    write(data?: string | Buffer | null, key?: Key): void {
        this.resume();

        if (key) {
            const str = data
                ? typeof data === "string"
                    ? data
                    : data.toString("utf8")
                : "";
            this._onKeypress(str, key);
            return;
        }

        if (data !== undefined && data !== null) {
            if (this.terminal) {
                const str =
                    typeof data === "string" ? data : data.toString("utf8");
                for (const char of str) {
                    if (char === "\r" || char === "\n") {
                        this._onKeypress("\r", { name: "return" });
                    } else {
                        this._onKeypress(char, { sequence: char, name: char });
                    }
                }
            } else {
                this._onData(data);
            }
        }
    }

    getCursorPos(): CursorPos {
        const promptLen = this._prompt ? this._prompt.length : 0;
        const cols = this.output?.columns || 80;
        const totalPos = promptLen + this.cursor;
        return {
            cols: totalPos % cols,
            rows: Math.floor(totalPos / cols)
        };
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<string> {
        return {
            next: () => {
                if (this._asyncQueue.length > 0) {
                    const item = this._asyncQueue.shift()!;
                    return Promise.resolve(item);
                }
                if (this.closed) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise<{ value: any; done: boolean }>((resolve) => {
                    this._asyncResolvers.push(resolve);
                });
            },
            return: () => {
                this.close();
                return Promise.resolve({ value: undefined, done: true });
            },
            [Symbol.asyncIterator]() {
                return this;
            }
        };
    }

    private _emitLine(line: string) {
        if (this._pendingQuestion) {
            const cb = this._pendingQuestion.cb;
            const cleanUp = this._pendingQuestion.cleanUp;
            this._pendingQuestion = null;
            if (cleanUp) cleanUp();
            cb(line);
        }

        if (this._asyncResolvers.length > 0) {
            const resolve = this._asyncResolvers.shift()!;
            resolve({ value: line, done: false });
        } else {
            this._asyncQueue.push({ value: line, done: false });
        }

        this.emit("line", line);
    }

    private _onData(chunk: any) {
        if (this.closed) return;
        const str =
            typeof chunk === "string" ? chunk : this._decoder.write(chunk);
        if (!str) return;

        let start = 0;
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (ch === "\r") {
                this._sawReturnAt = Date.now();
                const line = this._lineBuffer + str.slice(start, i);
                this._lineBuffer = "";
                start = i + 1;

                if (i + 1 < str.length && str[i + 1] === "\n") {
                    i++;
                    start = i + 1;
                    this._sawReturnAt = 0;
                    this._emitLine(line);
                } else if (this.crlfDelay === Infinity) {
                    this._emitLine(line);
                } else {
                    if (this._crlfTimer) clearTimeout(this._crlfTimer);
                    this._crlfTimer = setTimeout(() => {
                        this._sawReturnAt = 0;
                        this._crlfTimer = null;
                    }, this.crlfDelay);
                    this._emitLine(line);
                }
            } else if (ch === "\n") {
                if (
                    this._sawReturnAt &&
                    (this.crlfDelay === Infinity ||
                        Date.now() - this._sawReturnAt <= this.crlfDelay)
                ) {
                    this._sawReturnAt = 0;
                    if (this._crlfTimer) {
                        clearTimeout(this._crlfTimer);
                        this._crlfTimer = null;
                    }
                    start = i + 1;
                    continue;
                }
                this._sawReturnAt = 0;
                const line = this._lineBuffer + str.slice(start, i);
                this._lineBuffer = "";
                start = i + 1;
                this._emitLine(line);
            }
        }

        if (start < str.length) {
            this._lineBuffer += str.slice(start);
        }
    }

    private _onEnd() {
        if (this.closed) return;
        if (this._decoder) {
            const remaining = this._decoder.end();
            if (remaining) {
                this._lineBuffer += remaining;
            }
        }
        if (this._lineBuffer.length > 0) {
            const line = this._lineBuffer;
            this._lineBuffer = "";
            this._emitLine(line);
        }
        this.close();
    }

    private _onKeypress(char: string, key: Key) {
        if (this.closed) return;

        if (key.ctrl && key.name === "c") {
            if (this.listenerCount("SIGINT") > 0) {
                this.emit("SIGINT");
            } else {
                this.close();
            }
            return;
        }

        if (key.ctrl && key.name === "z") {
            if (this.listenerCount("SIGTSTP") > 0) {
                this.emit("SIGTSTP");
            }
            return;
        }

        if (key.ctrl && key.name === "d") {
            if (this.line.length === 0) {
                this.close();
                return;
            }
            if (this.cursor < this.line.length) {
                this.line =
                    this.line.slice(0, this.cursor) +
                    this.line.slice(this.cursor + 1);
                this._refreshLine();
            }
            return;
        }

        if (key.name === "return" || key.name === "enter") {
            const line = this.line;
            this._addHistory();
            this.line = "";
            this.cursor = 0;
            if (this.output) {
                this.output.write("\r\n");
            }
            this._emitLine(line);
            return;
        }

        if (key.name === "backspace") {
            if (this.cursor > 0) {
                this.line =
                    this.line.slice(0, this.cursor - 1) +
                    this.line.slice(this.cursor);
                this.cursor--;
                this._refreshLine();
            }
            return;
        }

        if (key.name === "delete") {
            if (this.cursor < this.line.length) {
                this.line =
                    this.line.slice(0, this.cursor) +
                    this.line.slice(this.cursor + 1);
                this._refreshLine();
            }
            return;
        }

        if (key.name === "left") {
            if (this.cursor > 0) {
                this.cursor--;
                this._refreshLine();
            }
            return;
        }

        if (key.name === "right") {
            if (this.cursor < this.line.length) {
                this.cursor++;
                this._refreshLine();
            }
            return;
        }

        if (key.name === "up") {
            if (this.history.length > 0) {
                if (this.historyIndex < this.history.length - 1) {
                    this.historyIndex++;
                    this.line = this.history[this.historyIndex];
                    this.cursor = this.line.length;
                    this._refreshLine();
                }
            }
            return;
        }

        if (key.name === "down") {
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.line = this.history[this.historyIndex];
                this.cursor = this.line.length;
                this._refreshLine();
            } else if (this.historyIndex === 0) {
                this.historyIndex = -1;
                this.line = "";
                this.cursor = 0;
                this._refreshLine();
            }
            return;
        }

        if (key.name === "home" || (key.ctrl && key.name === "a")) {
            this.cursor = 0;
            this._refreshLine();
            return;
        }

        if (key.name === "end" || (key.ctrl && key.name === "e")) {
            this.cursor = this.line.length;
            this._refreshLine();
            return;
        }

        if (key.ctrl && key.name === "u") {
            this.line = this.line.slice(this.cursor);
            this.cursor = 0;
            this._refreshLine();
            return;
        }

        if (key.ctrl && key.name === "k") {
            this.line = this.line.slice(0, this.cursor);
            this._refreshLine();
            return;
        }

        if (key.ctrl && key.name === "w") {
            if (this.cursor > 0) {
                let idx = this.cursor - 1;
                while (idx > 0 && this.line[idx] === " ") idx--;
                while (idx > 0 && this.line[idx - 1] !== " ") idx--;
                this.line =
                    this.line.slice(0, idx) + this.line.slice(this.cursor);
                this.cursor = idx;
                this._refreshLine();
            }
            return;
        }

        if (key.name === "tab") {
            if (this.completer) {
                this._tabComplete();
            }
            return;
        }

        if (char && !key.ctrl && !key.meta) {
            this.line =
                this.line.slice(0, this.cursor) +
                char +
                this.line.slice(this.cursor);
            this.cursor += char.length;
            this._refreshLine();
        }
    }

    private _refreshLine() {
        if (!this.output) return;
        const prompt = this._prompt || "";
        this.output.write("\r\x1b[2K" + prompt + this.line);
        const cursorPos = prompt.length + this.cursor;
        this.output.write(`\r\x1b[${cursorPos}C`);
    }

    private _addHistory() {
        if (
            !this.terminal ||
            this.historySize === 0 ||
            this.line.length === 0
        ) {
            return;
        }

        if (this.removeHistoryDuplicates) {
            const idx = this.history.indexOf(this.line);
            if (idx !== -1) {
                this.history.splice(idx, 1);
            }
        } else if (this.history[0] === this.line) {
            return;
        }

        this.history.unshift(this.line);
        if (this.history.length > this.historySize) {
            this.history.pop();
        }
        this.historyIndex = -1;
        this.emit("history", this.history);
    }

    private _tabComplete() {
        if (!this.completer) return;

        const handleResult = (result?: CompleterResult) => {
            if (!result) return;
            const [completions, match] = result;
            if (!completions || completions.length === 0) return;

            if (completions.length === 1) {
                const completion = completions[0];
                const suffix = completion.slice(match.length);
                this.line =
                    this.line.slice(0, this.cursor) +
                    suffix +
                    this.line.slice(this.cursor);
                this.cursor += suffix.length;
                this._refreshLine();
            } else {
                let prefix = completions[0];
                for (let i = 1; i < completions.length; i++) {
                    const c = completions[i];
                    let j = 0;
                    while (
                        j < prefix.length &&
                        j < c.length &&
                        prefix[j] === c[j]
                    ) {
                        j++;
                    }
                    prefix = prefix.slice(0, j);
                }

                if (prefix.length > match.length) {
                    const suffix = prefix.slice(match.length);
                    this.line =
                        this.line.slice(0, this.cursor) +
                        suffix +
                        this.line.slice(this.cursor);
                    this.cursor += suffix.length;
                    this._refreshLine();
                } else if (this.output) {
                    this.output.write("\r\n" + completions.join("  ") + "\r\n");
                    this._refreshLine();
                }
            }
        };

        if (this.completer.length === 2) {
            (this.completer as AsyncCompleter)(this.line, (err, res) => {
                if (!err && res) handleResult(res);
            });
        } else {
            const res = (this.completer as Completer)(this.line);
            if (res && typeof (res as any).then === "function") {
                (res as any).then(handleResult);
            } else {
                handleResult(res);
            }
        }
    }
}

export function createInterface(
    inputOrOptions?: any,
    output?: any,
    completer?: Completer | AsyncCompleter,
    terminal?: boolean
): Interface {
    if (
        !inputOrOptions ||
        (typeof inputOrOptions === "object" &&
            !("on" in inputOrOptions) &&
            !("read" in inputOrOptions))
    ) {
        return new Interface(inputOrOptions);
    }
    return new Interface({
        input: inputOrOptions,
        output,
        completer,
        terminal
    });
}

export const InterfaceConstructor = Interface;

export default {
    Interface,
    InterfaceConstructor,
    createInterface,
    emitKeypressEvents,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor
};
