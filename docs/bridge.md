# The bridge

The bridge is how JavaScript running in a webview (or in Node, for the CLI) calls into the Go core. Every core-backed Node module ([`fs`](node/system.md#fs), [`net`](node/networking.md#net), [`crypto`](node/crypto-zlib.md#crypto), …) and every [runtime module](api/index.md) is a thin TypeScript layer over it.

This page covers the whole path of a call: the payload, how it reaches the core on each platform, how responses and streams come back, and how workers join in. To write a new host, see [Porting to a new host](contributing/porting-a-host.md).

```text
┌────────────── page / worker ──────────────┐
│  your code → lib module (fs, git, …)      │
│      → fullstacked.bridge({mod, fn, data}) │
│      → bridge/platform.ts (transport)      │
└───────────────────┬────────────────────────┘
                    │ HTTP requests on the app's origin
                    │ or a message channel of the webview
┌───────────────────▼────────────────────────┐
│  host (Swift, Kotlin, C#, C++, Node addon) │
│      → C ABI of the core                    │
└───────────────────┬────────────────────────┘
┌───────────────────▼────────────────────────┐
│  Go core: router → module Switch(fn)        │
│      → response | stream frames             │
└─────────────────────────────────────────────┘
```

## The call

A lib module makes a call through `globalThis.fullstacked.bridge`:

```ts
// sync: blocks until the core answers, returns the value or throws
const exists = fullstacked.bridge(
    { mod: Fs, fn: Exists, data: ["/a.txt"] },
    true
);

// async: returns a Promise
const contents = await fullstacked.bridge({
    mod: Fs,
    fn: ReadFile,
    data: ["/a.txt"]
});
```

`mod` and `fn` are numbers. `data` is a list of serializable values. `ctx` can be given to call into another [context](architecture.md#contexts); by default it is the page's own context. `fullstacked.bridge` is an internal API. Projects should use the Node modules and the [runtime modules](api/index.md), whose signatures are stable.

### Payload

A call is one binary payload:

| Byte | Field  | Notes                                                                   |
| ---- | ------ | ----------------------------------------------------------------------- |
| 0    | `ctx`  | Context id (u8), read once from `GET /ctx`                              |
| 1    | `id`   | Call id (u8, 1–255), unique among the runtime's calls in flight         |
| 2    | `mod`  | Core module                                                             |
| 3    | `fn`   | Function of that module                                                 |
| 4    | `sync` | 1 for a sync call, 0 for async. The core doesn't use it; transports do. |
| 5…   | args   | The serialized `data` values, concatenated                              |

### Call ids

Ids are one byte. Id 0 is never used, so at most **255 calls** can be in flight per runtime (a page, or each worker for its sync calls). `acquireId()` hands ids out round-robin. While an id is free and nobody is waiting, it returns synchronously, so the call is posted in the same tick and calls go out in the order they were made. When all 255 are taken, async calls wait for an id in FIFO order. A sync call can't wait, so it throws `too many bridge calls in flight`. The id is released as soon as the response arrives.

### Modules and functions

The ids are declared in Go (`core/types/types.go` and each module's `const` block) and generated into TypeScript (`core/internal/bundle/lib/@types/*.ts`) by `npm run generate-types` (tygo).

| Id  | Module    | Functions                                                                                                                                |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Core      | StaticFile, Run, Cwd, Chdir, GetEnv, Exit, DeepLink, Version                                                                             |
| 1   | Stream    | Open, Write, WriteEvent, Close                                                                                                           |
| 2   | Test      | Hello, Serialization, SerializationIndex, Stream, StreamWrite, EventEmitter, Panic, BenchEcho, BenchStream                               |
| 3   | Fs        | Exists, Stats, ReadFile, ReadDir, Mkdir, Rm, WriteFile, Rename, Copy, CreateWriteStream*, AppendFile, CreateReadStream*                  |
| 4   | Path      | Join, Resolve, Normalize, Relative, Parse                                                                                                |
| 5   | Os        | Platform, Arch, Endianness, Uname, Hostname                                                                                              |
| 6   | Net       | Connect\*                                                                                                                                |
| 7   | Tunnel    | Register                                                                                                                                 |
| 8   | Fetch     | Fetch*, ResponseBody*, Cancel                                                                                                            |
| 9   | Bundle    | EsbuildVersion, BundleDir\*, BundleFile, BuilderTailwindCSS, BuilderSASS                                                                 |
| 10  | Dns       | Resolve4, Resolve6, ResolveCNAME, ResolveMX, ResolveNS, ResolveSRV, ResolveTXT, Lookup                                                   |
| 11  | Git       | HasGit, Init, Head, Status, Add, Log, Commit, Clone*, Pull*, Push*, Reset, Branch*, Tags*, Checkout*, Merge, Restore, SetConfig, Fetch\* |
| 12  | Packages  | Install*, Uninstall*, Audit, ResolvePackages, AddResolveNodePath                                                                         |
| 13  | Dgram     | CreateSocket\*                                                                                                                           |
| 14  | Plugin    | StartPluginStream\*, Register, Unregister, Ready                                                                                         |
| 15  | WebSocket | Connect\*                                                                                                                                |
| 16  | Config    | Get, Set, List, Delete                                                                                                                   |
| 17  | Crypto    | Hash…, Cipher…, Aead, Key…, Sign, Verify, DiffieHellman, Dh…, Ecdh…, Pbkdf2, Scrypt, Hkdf, RsaCrypt, Free                                |
| 18  | Zlib      | Compress, Decompress, StreamCreate, StreamWrite, StreamEnd, StreamParams, StreamReset, Free                                              |

\* returns a [stream](#streams).

In Go, the router (`core/internal/router`) parses the header, deserializes the arguments and calls `modules[mod].Switch(ctx, header, data, &response)`, which switches on `fn`. A returned Go `error` becomes an error response. Crypto and zlib keep their handles (hashes, ciphers, compressors) in the context under `uint32` ids, which the JavaScript side frees with `Free`.

## Serialization

Arguments and response data use a small tagged binary format, the same in Go (`core/internal/serialization`) and TypeScript (`lib/bridge/serialization.ts`). All integers are big-endian.

| Tag | Type      | Encoding                      | JavaScript ↔ Go                                                              |
| --- | --------- | ----------------------------- | ---------------------------------------------------------------------------- |
| 0   | UNDEFINED | `[0]`                         | `undefined` and `null` ↔ `nil`. Always decodes to `undefined`.               |
| 1   | BOOLEAN   | `[1][0 or 1]`                 | `boolean` ↔ `bool`                                                           |
| 2   | STRING    | `[2][length u32][UTF-8]`      | `string` ↔ `string`                                                          |
| 3   | NUMBER    | `[3][float64]`                | `number` ↔ `float64`                                                         |
| 4   | BUFFER    | `[4][length u32][bytes]`      | `Uint8Array` ↔ `[]byte`                                                      |
| 5   | OBJECT    | `[5][length u32][UTF-8 JSON]` | plain `Object` or `Array` ↔ raw JSON, which each Go module unmarshals itself |

Values are simply concatenated, and a list of arguments is read back by walking each value's size. Any other JavaScript value (a `Map`, a class instance, a `bigint`) makes `serialize` throw. In Go, anything that isn't one of the first five types (a struct, a map, a slice, an `int`) is sent as OBJECT JSON. Lengths are capped at 2³²−1.

## Responses

The core answers every call with one response:

| First byte | Type   | Rest                             | JavaScript result                                           |
| ---------- | ------ | -------------------------------- | ----------------------------------------------------------- |
| 0          | Error  | a STRING message                 | throws or rejects `Error("error from bridge: [<message>]")` |
| 1          | Data   | one serialized value, or nothing | that value, or `undefined`                                  |
| 2          | Stream | a NUMBER stream id               | a [Duplex](#streams) on that id                             |

Errors cross the bridge as their message only. There is no `code`, no stack and no error class. The Node layers rebuild Node-shaped errors where they can (`net`, `fs` streams, `crypto`, `zlib`).

## Transports

`lib/bridge/platform.ts` is a single file that runs on every host. It never asks which platform it runs on. Instead it detects what the host offers and uses plain HTTP requests for everything else.

### Requests

Every host serves the page's origin and answers these requests:

| Request              | Answer                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /ctx`           | The page's context id, as text                                                                                                       |
| `GET /bridge`        | `binary` when the host passes request bodies to the core, `message` when it can't (Android, Qt before 6.7)                           |
| `POST /call`         | Body: a call payload. Response: the core response.                                                                                   |
| `POST /sync`         | Same as `/call`, sent as a **synchronous** `XMLHttpRequest`. The page waits for it.                                                  |
| `GET /sync/{id}`     | The response of a sync call that was sent as a message (hosts that read no bodies), in base64                                        |
| `GET /stream`        | The long-lived [frame stream](#frames)                                                                                               |
| `GET /stream/detach` | Gives up frames and goes back to [evaluated chunks](#evaluated-chunks)                                                               |
| `GET /platform`      | The host's name. Informational only.                                                                                                 |
| `GET /version`       | `{ major, minor, patch, build, branch, hash }` of the core. Stable, so pages built for older runtimes can read it.                   |
| `GET /open?ctx=N`    | The host opens a window for context `N` (see [`run`](api/run.md))                                                                    |
| `GET /exit`          | The host closes the window                                                                                                           |
| `GET /resize`        | `?size=w:h:x:y`, `kiosk` or `fullscreen` sets the window; no query returns the current size. Only exists where the host answers 200. |
| anything else        | A [static file](project-structure.md#static-files) of the project, or 404                                                            |

A sync XHR from a page can't ask for an `arraybuffer`, so the page reads the response as `text/plain; charset=x-user-defined` and maps each char back to a byte. Workers can use `responseType = "arraybuffer"`. The page sends an `X-Body-Size` header with every body, for Qt, whose scheme handler gets no `Content-Length`.

With no message channel (the Node CLI), every call is a request.

### Message channels

A request through a webview has a fixed cost of 0.1 to 2 ms. A message on a channel the webview offers is cheaper for small calls, so the page uses the first channel it finds, in this order:

| Host                                     | Channel                                                                                                                                                                                                                                                                                         | Sync calls                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Apple (WKWebView), Linux GTK (WebKitGTK) | `webkit.messageHandlers.call`, a script message handler with reply. Payload and reply in base64.                                                                                                                                                                                                | `POST /sync`                                              |
| Windows (WebView2)                       | `chrome.webview.postMessage`. Replies are batched once per UI tick as `R<id>:<base64>;<id>:<base64>…`. With the [shared buffer](#webview2-shared-buffer), calls and replies go through rings instead.                                                                                           | A shared-buffer slot the page spins on, else `POST /sync` |
| Android (WebView)                        | The `fullstackedCore` JavascriptInterface and a `fullstackedBridge` web message listener. Calls made in the same tick are batched into one message, `[length u32 BE][payload]…`. Replies come back the same way, as `[id u8][length u32 BE][response]…`. An `init`/`ready` handshake starts it. | `fullstackedCore.coreCall`, answered at once              |
| Linux Qt (QtWebEngine)                   | `bridge.postMessage(base64, callback)` on a QWebChannel object                                                                                                                                                                                                                                  | Message, then `GET /sync/{id}`                            |

Calls of **16 KiB or more** are always `POST /call`, because a message would cost more. WebView2 is the exception: messages are cheaper than any request there. Going the other way, a response of 16 KiB or more to a message is not put in the reply. The core puts it on the [frame stream](#frames) as a _response frame_ (flag 3, with the call id in the stream-id field), and the reply is empty. `lib/bridge/responses.ts` matches the two, whichever arrives first.

Hosts run a page's calls in the order they arrive, on one serial queue per webview, off the UI thread. Static files are served concurrently. A small call sent by message and a large one sent by `POST /call` can overtake each other, so code that needs order must await calls in turn. The runtime's own modules do.

### WebView2 shared buffer

WebView2 can't stream a response body, and each `WebResourceRequested` costs about 2 ms. The Windows host therefore maps one `CoreWebView2SharedBuffer` per webview into both processes (`platform/windows/Channel.cs`):

- **Sync calls.** The page writes the payload into a request slot, posts `#s`, and spins on the response slot's state word until the host publishes the response. A response larger than the slot arrives in chunks that the page acknowledges. Slot layout: request `[u32 state][u32 length][bytes]`, response `[u32 state][u32 length][u32 total][bytes]`. Timeout is 30 s.
- **Async calls** are appended to a request ring, and the page posts `#a`. Responses come back in a response ring as `[id u8][response]` records, and stream frames come back in a frame ring. The page drains both on the `R` message the host posts once per UI tick.
- **Rings** are `[u32 head][u32 tail][pad to 64][data]`, with one producer and one consumer. Records are `[u32 length][bytes]` and never wrap: a length of `0xFFFFFFFF`, or fewer than 4 bytes left, means the next record is at 0.

## Streams

A function that produces data over time (a file read, a socket, an HTTP body, `git clone` progress, `npm install` output) returns a **stream**. The response holds a stream id, and the JavaScript side wraps it in a `Duplex` (`lib/bridge/duplex.ts`):

| Method                                 | Use                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `on("data" \| "close" \| "error", fn)` | Chunks as `Uint8Array`, the end, the failure                                                   |
| `for await (const chunk of duplex)`    | Pulls chunks, merging whatever is pending per read                                             |
| `write(chunk)`                         | `Stream.Write`. Resolves once the core accepted the bytes (see [flow control](#flow-control)). |
| `writeEvent(name, ...args)`            | `Stream.WriteEvent`, a named message to the producer (`send` and `close` on a WebSocket)       |
| `end()`                                | `Stream.Close`. Resolves on the close.                                                         |
| `promise()`                            | All bytes, once the stream ends                                                                |
| `eventEmitter()`                       | Decodes the stream as [events](#events)                                                        |
| `open()`, `connected()`                | Open explicitly; wait for a socket's dial                                                      |

The producer doesn't start until JavaScript calls `Stream.Open`. That happens lazily, on the first listener, `write`, `end` or iteration, so the caller can attach handlers before any data flows. In Go, `Open` runs in its own goroutine.

Stream ids are **32-bit** (1 to 2³¹−1, so they fit a Java `int`). Id 0 is reserved. Ids are reused once a stream ends. A context can hold any number of open streams. If no id is free, the call fails with `too many open streams`. A Duplex whose id is reused while it is still draining is queued behind the old one.

### Ending

- **The producer ends.** The end flag fires `close`. Exactly one end is sent, and late chunks are dropped.
- **The producer fails.** The error flag carries the message, `error` fires, and a pending read rejects.
- **JavaScript ends it.** `Stream.Close` runs the producer's `Close` (which closes a socket, cancels a fetch, …). Writes that are still queued go out first, then the end comes back.
- **Data for an unknown id.** JavaScript closes the stream, so a producer whose page went away stops.

When a context ends (window closed, `process.exit()`), the core closes all its streams.

### Events

Some streams carry named events instead of raw bytes: `fetch` (`response`, `error`), `bundle` (`result`), `git` and `packages` progress, plugins and WebSockets. Each event is a record `[length u32 BE][STRING name][serialized args…]`. Records can be split across chunks, and `duplex.eventEmitter()` reassembles them into an `EventEmitter`.

### Flow control

- **Core to page.** While a frame reader is attached, a producer blocks once **8 MiB** of frames are queued for the context. A socket stops reading, and a file read waits.
- **Page to core (sockets and tunnels).** `Stream.Write` queues the bytes and returns at once. A goroutine per stream writes them in order, joining chunks into writes of up to 1 MiB. Once more than **1 MiB** is queued, `write()` waits for a **drain** signal, which the core sends when the queue falls to 256 KiB.
- **Sockets dial off the bridge call.** `net.connect` returns the stream at once and the core dials in `Open`, so concurrent connects don't wait on each other. A **connected** signal resolves `duplex.connected()`, and writes made before it wait for the dial.
- **Node host.** Each open stream holds a ref (`fullstacked.keepAlive(+1/-1)`), so the CLI process stays alive while a socket or read is open, as in Node.

### Frames

Stream data reaches the page as **frames** on one long-lived response per page (`core/internal/frames`, `lib/bridge/frames.ts`):

```text
[streamId u32 BE][flags u8][length u32 BE][data]
```

| Flag | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | Data                                                    |
| 1    | End                                                     |
| 2    | Error (the data is the message)                         |
| 3    | Response of a call (the stream id field is the call id) |
| 4    | Drain (empty)                                           |
| 5    | Connected (empty)                                       |

How the page attaches:

1. The page fetches `GET /stream`. The host calls `streamAttach(ctx)`, then loops `streamRead`, which blocks and returns whole frames, writing each batch to the response.
2. The core queues a **hello** frame (stream 0, empty) first. The page switches to frames as soon as it reads the hello (`fullstacked.streamTransport = "frames"`). With no hello within 3 s, it calls `/stream/detach` and keeps [evaluated chunks](#evaluated-chunks).
3. Webviews hold back the tail of a streaming response until more bytes arrive, so after data the core sends **keepalive** frames (stream 0, empty) at 1, 10, 100 and 500 ms, and immediately after a response frame.
4. A reload attaches a new reader, which ends the previous one. If the host ends the response (Android caps a response's length, so it ends it about every 1 GB), the page fetches `/stream` again. The core keeps the frames queued in the meantime.

On WebView2 the frames come in the shared buffer's frame ring (`streamTransport = "shared-buffers"`).

### Evaluated chunks

Before the frame stream is up, or when a host can't serve it, the core falls back to a per-chunk callback. It buffers the chunk and calls the host's `onStreamData(ctx, id, size)`. The host pulls the bytes with `getCorePayload(ctx, 2, id, …)` (`[flags][data]`) and calls `window.fullstacked.onStreamData(id, payload)` in the page: base64 in an evaluated script on webviews, an `ArrayBuffer` on Node. `fullstacked.streamTransport` is `"evaluated"` while this path is in use.

## Workers

Workers (`new Worker(…)` or [`worker_threads`](node/workers.md#worker_threads)) run the same lib and share their page's context.

- **Startup.** A worker waits for the first message from its parent (`{ cwd }`), then reads `GET /ctx` and `GET /bridge` like a page.
- **Async calls are relayed through the main thread.** The worker posts the payload (transferred). The main thread swaps in an id from its own allocator, makes the call, and replies with `[worker id][response]`. When the response is a stream, the main thread records that the stream belongs to that worker and forwards its frames as `{ type: "on-stream-data" }` messages. Workers never read `/stream` themselves.
- **Sync calls** are a sync `POST /sync` XHR from the worker. On hosts that read no bodies, the worker posts the payload to the main thread, which forwards it with `Send`, and the worker then blocks on `GET /sync/{id}`.
- **Terminating a worker** drops its stream mappings.

`DOMParser`, `XMLSerializer` and the DOM node classes are installed in workers, which have no DOM (see [Globals](node/index.md#globals)).

## The Node host

The CLI (`platform/node`) loads the core as a Node addon (`gyp/bridge.cc`) and serves pages over plain HTTP (`src/bridge.ts`). It also runs a project's code directly in Node with `--file`, in which case `fullstacked.bridge` calls the addon in-process: `core.call` stores the response under the call id, and `getCorePayload(ctx, 1, id, …)` reads it back. Stream chunks reach JavaScript through a thread-safe function. See [CLI](cli.md).

## Performance

Typical numbers on desktop: a small async call takes 0.06 to 0.2 ms, a 64 KiB echo 0.2 to 0.8 ms, and streams reach 500 to 3000 MB/s with 256 KiB chunks. `fullstacked.streamTransport` tells you which stream path a page is on. The bench lives in the shell (`bench`) and in `test/bench`.
