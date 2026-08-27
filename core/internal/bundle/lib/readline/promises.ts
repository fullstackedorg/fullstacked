import {
    Interface as _Interface,
    clearLine as _clearLine,
    clearScreenDown as _clearScreenDown,
    cursorTo as _cursorTo,
    moveCursor as _moveCursor,
    Direction
} from "./interface.ts";

export class Interface extends _Interface {
    override question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
    override question(query: string, callback: (answer: string) => void): void;
    override question(
        query: string,
        options: { signal?: AbortSignal },
        callback: (answer: string) => void
    ): void;
    override question(
        query: string,
        optionsOrCallback?: any,
        callback?: (answer: string) => void
    ): any {
        if (typeof optionsOrCallback === "function" || typeof callback === "function") {
            return super.question(query, optionsOrCallback, callback!);
        }

        if (this.closed) {
            return Promise.reject(new Error("readline: Interface is closed"));
        }

        const signal = optionsOrCallback?.signal;
        if (signal?.aborted) {
            const reason = (signal as any).reason || new Error("The operation was aborted");
            return Promise.reject(reason);
        }

        return new Promise<string>((resolve, reject) => {
            let onAbort: (() => void) | undefined;

            if (signal) {
                onAbort = () => {
                    const reason = (signal as any).reason || new Error("The operation was aborted");
                    reject(reason);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }

            super.question(query, { signal }, (answer: string) => {
                if (signal && onAbort) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve(answer);
            });
        });
    }
}

export class Readline {
    private stream: any;
    private autoCommit: boolean;
    private _actions: Array<() => boolean> = [];

    constructor(stream: any, options?: { autoCommit?: boolean }) {
        this.stream = stream;
        this.autoCommit = Boolean(options?.autoCommit);
    }

    clearLine(dir: Direction): this {
        const action = () => _clearLine(this.stream, dir);
        if (this.autoCommit) {
            action();
        } else {
            this._actions.push(action);
        }
        return this;
    }

    clearScreenDown(): this {
        const action = () => _clearScreenDown(this.stream);
        if (this.autoCommit) {
            action();
        } else {
            this._actions.push(action);
        }
        return this;
    }

    cursorTo(x: number, y?: number): this {
        const action = () => _cursorTo(this.stream, x, y);
        if (this.autoCommit) {
            action();
        } else {
            this._actions.push(action);
        }
        return this;
    }

    moveCursor(dx: number, dy: number): this {
        const action = () => _moveCursor(this.stream, dx, dy);
        if (this.autoCommit) {
            action();
        } else {
            this._actions.push(action);
        }
        return this;
    }

    rollback(): this {
        this._actions = [];
        return this;
    }

    async commit(): Promise<void> {
        const actions = this._actions;
        this._actions = [];
        for (const action of actions) {
            action();
        }
    }
}

export function createInterface(
    inputOrOptions?: any,
    output?: any,
    completer?: any,
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

export default {
    Interface,
    Readline,
    createInterface
};
