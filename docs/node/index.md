# Node.js compatibility

A FullStacked project imports Node's built-in modules the way it would in Node. Both spellings work: `import fs from "fs"` and `import fs from "node:fs"`. Nothing comes from npm. The runtime serves each built-in from its own library, written in TypeScript and embedded in the core (`core/internal/bundle/lib`). Work that needs the operating system, or that is too heavy for JavaScript, goes over the [bridge](../bridge.md) to the Go core.

The modules fall into three groups:

- **Pure TypeScript.** They run in the page or worker with no core call: `buffer`, `events`, `stream`, `util`, `assert` and the rest. They are written from Node 22/24's behavior and tested against `node:<module>` itself.
- **Core-backed.** Their JavaScript side calls the core for files, paths, sockets, compression or cryptography: `fs`, `path`, `net`, `dgram`, `dns`, `os`, `process`, `crypto`, `zlib`.
- **Not available.** `http`, `child_process`, `vm` and the others listed on [Unavailable modules](unavailable.md).

## Module table

| Module                                                                               | Status                               | Runs in                  | Page                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------ | --------------------------------------------------- |
| `assert`                                                                             | full                                 | page                     | [Pure modules](pure.md#assert)                      |
| `buffer`                                                                             | full                                 | page                     | [Pure modules](pure.md#buffer)                      |
| `console`                                                                            | the global console                   | page                     | [Pure modules](pure.md#console)                     |
| `constants`                                                                          | full                                 | page                     | [Pure modules](pure.md#constants)                   |
| `diagnostics_channel`                                                                | full                                 | page                     | [Pure modules](pure.md#diagnostics_channel)         |
| `events`                                                                             | full                                 | page                     | [Pure modules](pure.md#events)                      |
| `perf_hooks`                                                                         | `performance` only                   | page                     | [Pure modules](pure.md#perf_hooks)                  |
| `querystring`                                                                        | full                                 | page                     | [Pure modules](pure.md#querystring)                 |
| `stream`, `stream/promises`, `stream/web`, `stream/consumers`                        | full                                 | page                     | [Pure modules](pure.md#stream)                      |
| `string_decoder`                                                                     | full                                 | page                     | [Pure modules](pure.md#string_decoder)              |
| `timers`, `timers/promises`                                                          | full                                 | page                     | [Pure modules](pure.md#timers)                      |
| `url`                                                                                | WHATWG + helpers (no legacy `parse`) | page                     | [Pure modules](pure.md#url)                         |
| `util`, `util/types`                                                                 | full, two documented differences     | page                     | [Pure modules](pure.md#util)                        |
| `path`                                                                               | partial                              | page + core              | [System modules](system.md#path)                    |
| `fs`, `fs/promises`                                                                  | partial                              | core                     | [System modules](system.md#fs)                      |
| `os`                                                                                 | partial                              | core                     | [System modules](system.md#os)                      |
| `process`                                                                            | partial                              | page + core              | [System modules](system.md#process)                 |
| `net`                                                                                | client sockets                       | core                     | [Networking](networking.md#net)                     |
| `dgram`                                                                              | UDP sockets                          | core                     | [Networking](networking.md#dgram)                   |
| `dns`, `dns/promises`                                                                | `lookup`                             | core                     | [Networking](networking.md#dns)                     |
| `crypto`                                                                             | broad                                | page + core              | [Crypto and zlib](crypto-zlib.md#crypto)            |
| `zlib`                                                                               | deflate, gzip, brotli (no zstd)      | core (+ `crc32` in page) | [Crypto and zlib](crypto-zlib.md#zlib)              |
| `worker_threads`                                                                     | `Worker`, `parentPort`               | web workers              | [Workers and terminals](workers.md#worker_threads)  |
| `readline`, `readline/promises`                                                      | full                                 | page                     | [Workers and terminals](workers.md#readline)        |
| `tty`                                                                                | `isatty()` only                      | page                     | [Workers and terminals](workers.md#tty)             |
| `http`, `https`, `http2`, `tls`                                                      | not available (stubs)                | none                     | [Unavailable](unavailable.md#http-https-http2-tls)  |
| `child_process`, `async_hooks`, `module`, `vm`, `v8`, `sqlite`                       | not available                        | none                     | [Unavailable](unavailable.md)                       |
| `cluster`, `inspector`, `repl`, `wasi`, `domain`, `punycode`, `trace_events`, `test` | not provided                         | none                     | [Unavailable](unavailable.md#modules-with-no-entry) |

Only the subpaths listed above are mapped. Others, such as `assert/strict`, `path/posix` and `path/win32`, don't resolve. Import the parent module and use its property instead (`assert.strict`, `path.posix`).

"Full" means the module's public API matches Node and passes the conformance suite in `test/shim`. Each page notes the differences that are left. They are deliberate choices, and each one is tested.

## How a built-in is resolved

The bundler (esbuild, run inside the core) has a plugin that catches every import before normal resolution:

1. A `node:` prefix is removed (`node:fs` → `fs`), and so is a trailing `/` (`process/` → `process`, the form some browserify-era packages use).
2. A `fullstacked/` prefix is removed (`fullstacked/git` → `git`). See the [runtime API](../api/index.md).
3. If the name is in the runtime's module table, the import resolves to the embedded library file. Otherwise normal `node_modules` resolution applies.

The table is matched **before** `node_modules`. A project therefore can't install an npm package whose name is a runtime module (`config`, `git`, `run`, `bundle`, `packages`, `plugin`, `tunnel`, `auth`, `fetch`, `websocket`, `test`, `parentWindow`) and import it by its bare name: the runtime's module wins. Polyfill packages such as `buffer`, `events`, `util` or `process` are replaced the same way, which is the intended effect. Old code that imports them gets the runtime's version.

`require()` of a built-in returns what Node's `require` returns. For `assert`, `buffer`, `constants`, `diagnostics_channel`, `events`, `querystring`, `stream`, `string_decoder`, `util` and `util/types`, that is the module object itself: `require("events")` is the `EventEmitter` function and `require("assert")` is the `assert` function. Every other built-in gives its namespace object, which has the same shape for those modules.

Imports of `*.node` native addons are left external, so they fail at runtime. Native addons can't run in a webview.

## Globals

The runtime installs these on `globalThis` before the project's code runs:

| Global                                            | What it is                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `process`                                         | The runtime's `process` (see [System modules](system.md#process)), if the environment has none                                    |
| `Buffer`                                          | `buffer.Buffer`                                                                                                                   |
| `setImmediate` / `clearImmediate`                 | A `MessageChannel` turn where the environment has none (Node's own is kept under `fullstacked --file`)                            |
| `fetch`                                           | The core's `fetch`: it reaches any origin with no CORS restriction (see [fetch and WebSocket](networking.md#fetch-and-websocket)) |
| `WebSocket`                                       | The core's WebSocket client, in pages and workers                                                                                 |
| `DOMParser`, `XMLSerializer` and DOM node classes | Installed in workers and under Node, where there is no DOM. The main thread keeps the browser's.                                  |
| `__dirname`                                       | `"/"`                                                                                                                             |
| `fullstacked`                                     | Runtime internals (`fullstacked.bridge`, …). Not a stable API.                                                                    |

The original `fetch` stays available as `globalThis.fullstacked.fetch`. A relative `fetch("/data.json")` still reads the project's static files (see [Project structure](../project-structure.md#static-files)).

## Running the conformance suite

```bash
npm test -- test/shim
```

Each `test/shim/<module>/index.ts` runs the same function against the runtime's module and against `node:<module>`, then compares the values or errors (`name` and `code`, not the message). Known differences are listed in `test/shim/known-failures.ts`, which is empty today.
