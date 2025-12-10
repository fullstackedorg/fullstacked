import { bridge } from "../bridge";
import { Mkdir, MkdirOptions } from "../@types/fs";
import { Fs } from "../@types/router";

type PathLike = string | Buffer | URL;
type Callback = (err: Error) => void;

export function mkdir(path: PathLike, callback: Callback): void;
export function mkdir(
    path: PathLike,
    options: { recursive: boolean },
    callback: Callback
): void;
export function mkdir(
    path: PathLike,
    options: { recursive: boolean } | Callback,
    callback?: Callback
): void {
    const p =
        path instanceof URL
            ? path.pathname
            : typeof path === "string"
              ? path
              : new TextDecoder().decode(path);

    const cb = typeof options === "function" ? options : callback;

    const opts: MkdirOptions = {
        Recursive: typeof options === "object" ? options?.recursive : undefined
    };
}
