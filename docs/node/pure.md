# Pure modules

These built-ins run entirely in the page or worker, with no core call. Most were rewritten from Node's own behavior (Node 22 or 24, as noted below) to replace the browserify-era npm shims (`buffer@6`, `events@3`, `util@0.12`, `readable-stream`, …), which matched Node 10 at best. Each one has a conformance file in `test/shim/<module>` that compares it with `node:<module>`.

Back to the [module table](index.md).

## assert

`node:assert` from Node 24: `ok`, `equal`, `notEqual`, `strictEqual`, `notStrictEqual`, `deepEqual`, `notDeepEqual`, `deepStrictEqual`, `notDeepStrictEqual`, `partialDeepStrictEqual`, `throws`, `rejects`, `doesNotThrow`, `doesNotReject`, `match`, `doesNotMatch`, `fail`, `ifError`, `AssertionError` and `assert.strict`. The `assert/strict` subpath is not mapped, so use `import { strict } from "assert"`. `require("assert")` is the `assert` function.

## buffer

`Buffer` with every encoding Node has, including `base64url`. Decoding of invalid base64 and UTF-8 follows Node, as do bounds checks with their `ERR_*` codes, `readUint*`/`writeUint*` lowercase aliases, `SlowBuffer`, `Blob`, `File`, `resolveObjectURL`, `atob`, `btoa`, `isUtf8`, `isAscii`, `transcode`, `kMaxLength`, `kStringMaxLength`, `INSPECT_MAX_BYTES` and `constants`. `Buffer` is also a global. Hex and base64 encoding are linear on every engine. The old npm shim was quadratic on JavaScriptCore.

## console

The global `console` of the page. `new console.Console(...)` returns an object whose methods forward to the global console; the streams passed to the constructor are ignored. Output appears in the webview's devtools and, under the CLI, in the terminal.

## constants

Node's `require("constants")` table as macOS reports it, generated from Node 24.22. `fs.constants`, `os.constants` and `crypto.constants` are slices of this table.

## diagnostics_channel

`node:diagnostics_channel` from Node 22: `channel`, `hasSubscribers`, `subscribe`, `unsubscribe`, `tracingChannel`, `Channel`.

## events

`node:events` from Node 22: `EventEmitter` with `errorMonitor`, `captureRejections`, the static `once` (with `AbortSignal`), `on` (async iterator), `getEventListeners`, `getMaxListeners`, `setMaxListeners`, `listenerCount`, `addAbortListener`, `EventEmitterAsyncResource`, `defaultMaxListeners` and `captureRejectionSymbol`. `EventTarget` and `Event` are the webview's globals; `once`, `on` and `getEventListeners` accept them. Errors carry Node's codes (`ERR_UNHANDLED_ERROR`, `ERR_INVALID_ARG_TYPE`, …).

## perf_hooks

`performance` only: the webview's `performance` object (`now()`, `timeOrigin`, `mark`, `measure`, …). `PerformanceObserver`, `monitorEventLoopDelay` and `createHistogram` are not provided.

## querystring

`node:querystring` from Node 22: `parse`/`decode` (with `sep`, `eq`, `maxKeys` and a custom `decodeURIComponent`), `stringify`/`encode`, `escape`, `unescape`, `unescapeBuffer`. `parse` returns a null-prototype object, as in Node.

## stream

`node:stream` from Node 24: `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `compose`, `addAbortSignal`, `duplexPair`, the operators (`map`, `filter`, `toArray`, …), `Readable.from`, `Readable.toWeb`/`fromWeb` and the other web stream adapters. Also:

- `stream/promises`: `pipeline`, `finished`
- `stream/web`: the webview's `ReadableStream`, `WritableStream`, `TransformStream` and related classes
- `stream/consumers`: `text`, `json`, `buffer`, `bytes`, `arrayBuffer`, `blob`

`process.nextTick`, which streams use to defer events, is a microtask queue in the runtime (see [process](system.md#process)). Event order matches Node's for the cases the suite covers.

## string_decoder

`StringDecoder` for every Node encoding, including `base64url`. Invalid UTF-8 split across chunks produces the same number of U+FFFD as Node.

## timers

`setTimeout`, `setInterval`, `setImmediate` and their `clear*` counterparts. `setImmediate` is a turn of a `MessageChannel`, not a 0 ms timer. Browsers clamp nested timers to 4 ms, and drivers that defer every write with `setImmediate` (node-redis, for example) would slow down. `timers/promises` has `setTimeout`, `setImmediate` and `setInterval` (an async iterator).

The timers return the webview's numeric ids, not Node `Timeout` objects. `ref()`, `unref()` and `refresh()` are not available on them.

## url

The WHATWG `URL` and `URLSearchParams` (the webview's own), plus `fileURLToPath`, `pathToFileURL`, `fileURLToPathBuffer`, `domainToASCII`, `domainToUnicode`, `format` and `urlToHttpOptions`. The legacy `url.parse()` and `url.resolve()` are **not** provided. Use `new URL(input, base)`.

## util

`node:util` from Node 24: `inspect` (every option, `inspect.custom`, `inspect.defaultOptions`, `<ref *1>` and `[Circular *1]`, class names, null prototypes), `format`, `formatWithOptions`, `promisify` (with `promisify.custom` as `Symbol.for("nodejs.util.promisify.custom")`), `callbackify`, `inherits`, `deprecate`, `debuglog`, `isDeepStrictEqual`, `parseArgs`, `styleText`, `stripVTControlCharacters`, `toUSVString`, `aborted`, `transferableAbortSignal`, `transferableAbortController`, `TextEncoder`, `TextDecoder`, and `util.types` (also importable as `util/types`). The legacy `util.isArray`, `isString`, … helpers are kept for old packages, even though Node 23 removed them.

Two differences remain, because a page can't observe either value:

- `util.inspect(promise)` prints `Promise { <unknown> }`.
- `util.types.isProxy()` always returns `false`.
