# Workers and terminals

Back to the [module table](index.md).

## worker_threads

`worker_threads` wraps the webview's module web workers. A worker shares its page's [context](../architecture.md#contexts), so it sees the same project files, environment and tunnels, and it can use every core-backed module. Its bridge calls are [relayed through the main thread](../bridge.md#workers).

```ts
// index.ts (main thread)
import { Worker } from "node:worker_threads";

const worker = new Worker("./worker.ts.js");
worker.on("message", (event) => console.log(event.data));
worker.postMessage({ file: "/data.csv" });
```

```ts
// worker.ts
import { parentPort } from "node:worker_threads";
import fs from "node:fs";

parentPort.on("message", (event) => {
    const csv = fs.readFileSync(event.data.file, "utf8");
    parentPort.postMessage(csv.split("\n").length);
});
```

**Workers aren't bundled with the page.** `bundle()` follows imports, not `new Worker(url)`, so build each worker file on its own with [`bundleFile`](../api/bundle.md#bundlefile). That writes `worker.ts.js` next to `worker.ts`, and the page loads it through the [static file fallback](../project-structure.md#static-files). See [Project structure → Workers](../project-structure.md#workers).

| API                        | Behavior                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Worker(url)`          | `new globalThis.Worker(url, { type: "module" })`. `url` is resolved against the page's URL, not the project directory. Options (`workerData`, `env`, `eval`, …) are not supported. |
| `worker.postMessage(data)` | Structured clone, as with web workers                                                                                                                                              |
| `worker.on("message", fn)` | `fn` receives the **`MessageEvent`**, not the data. Read `event.data`.                                                                                                             |
| `worker.on("exit", fn)`    | Fires when the worker calls `process.exit()`                                                                                                                                       |
| `worker.terminate()`       | Terminates the worker and drops its streams                                                                                                                                        |
| `parentPort`               | In a worker, an `EventEmitter` whose `message` listeners receive the `MessageEvent`, plus `postMessage`. `null` on the main thread.                                                |

**Not provided**: `isMainThread`, `workerData`, `threadId`, `MessageChannel`/`MessagePort` from the module (the global `MessageChannel` works), `SharedArrayBuffer` sharing options, `resourceLimits`, `receiveMessageOnPort`, and `BroadcastChannel` from the module. The module has **no default export**, so use named imports: `import { Worker, parentPort } from "worker_threads"`.

The web `Worker` constructor can be used directly too. The bridge initializes in any module worker that imports a runtime module.

## readline

`node:readline` and `readline/promises` are ported in full: `createInterface`, `Interface` (`question`, `prompt`, `line` events, history, completer, `[Symbol.asyncIterator]`), `emitKeypressEvents`, `clearLine`, `clearScreenDown`, `cursorTo` and `moveCursor`. They work over any streams you give them. In the FullStacked app, `process.stdin` and `process.stdout` are the shell's terminal (xterm.js), so CLI-style programs that prompt with readline run inside the app. Under `fullstacked --file` they are Node's real stdio.

The CLI keeps a `--file` script alive while one of its readline interfaces is open (`waitForInterfaces`).

## tty

`isatty()` always returns `false`. The `ReadStream` and `WriteStream` constructors throw. Terminal-aware packages fall back to their non-TTY output.
