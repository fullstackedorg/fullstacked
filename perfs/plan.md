# WebView ⇄ Go Core Bridge: Performance Report

Branch reviewed: `v1` (at `5ffcd9c`)
Scope: the transport between the webview JS runtime and the Go core on every platform (Apple, Android, Windows, Linux GTK/Qt, Node).

---

## 1. Summary

The protocol and the C ABI are well designed:

- a compact binary wire format: 5-byte header `[ctx, id, module, fn, sync]` plus custom serialization (`core/internal/router/router.go`)
- a small C surface: `call`, `getCorePayload`, `setOnStreamData`, plus lifecycle (`core/main.go`)
- a single JS contract, `PlatformBridge { ctx, Async, Sync }` (`core/internal/bundle/lib/bridge/platform/index.ts`)

Almost all of the cost is in the **transport** that each platform builds on top of that. Every native platform:

1. base64-encodes the request in JS,
2. sends it as a string over a message channel,
3. runs the Go call **on the UI thread** (Apple, Windows, GTK),
4. base64-encodes the response,
5. **evaluates the response as JavaScript source** (`evaluateJavaScript("respond(id, \`<base64>\`)")`), once per async response and once per stream chunk,
6. decodes base64 again in JS.

Sync calls use two different IPC mechanisms (a postMessage plus a sync XHR to `/sync/{id}`), with awaiter dictionaries and locks on both sides.

Node is the only platform with a binary request path (`fetch POST /call`) and a binary push path (WebSocket).

**Recommendation:** make the custom-scheme request handler, which every platform already has for static files, the single transport. It should carry binary request bodies, binary responses, and long-lived streaming responses, and run off the UI thread. That removes base64 and `evaluateJavaScript` from the data path, collapses five JS bridges into one, and turns each native host into roughly 100 lines of glue.

---

## 2. Current transport per platform

| Platform | JS → native | native → JS (async) | Sync | Streams |
|---|---|---|---|---|
| Apple (WKWebView) | base64 → `messageHandlers.bridge.postMessage` | `evaluateJavaScript` with base64 | postMessage + sync XHR `fs://…/sync/{id}` | `evaluateJavaScript` per chunk, main thread |
| Android | base64 → `@JavascriptInterface coreCall` | `evaluateJavascript` via main Handler | direct return (main JS); workers: postMessage + XHR | `evaluateJavascript` per chunk |
| Windows (WebView2) | base64 → `chrome.webview.postMessage` (UI thread) | `ExecuteScriptAsync` | postMessage + `WebResourceRequested /sync/{id}` | `ExecuteScriptAsync` per chunk |
| Linux GTK | base64 → script message handler | `webkit_web_view_evaluate_javascript` | postMessage + URI scheme `/sync/{id}` | same, per chunk |
| Linux Qt | base64 over QWebChannel (JSON framed) | `runJavaScript` | QWebChannel + scheme `/sync/{id}` | same, per chunk |
| Node | `fetch POST /call`, binary | binary `arrayBuffer()` | sync XHR `POST /sync`, response base64 | WebSocket, binary |

---

## 3. Where the time goes (one native round trip)

| # | Step | Cost | Where |
|---|---|---|---|
| 1 | JS base64 encode (hand-rolled, 148 lines) | CPU, +33% size | `bridge/base64.ts` |
| 2 | String across the webview IPC (UTF-16 in JSC/V8) | ~2.6× the raw bytes in memory | all native |
| 3 | Native base64 decode | CPU, allocation | Swift/Kotlin/C#/C++ |
| 4 | `C.GoBytes` copies the request into Go | copy | `core/main.go` `call` |
| 5 | Two C calls per request (`call`, then `getCorePayload`) with a map store in between | locking, map churn | `core/internal/store/store.go` |
| 6 | **Double copy** in `getCorePayload`: `C.CBytes` (malloc + copy) → `memcpy` into the host buffer → `free` | extra alloc + copy per response/chunk | `core/main.go:118-120` |
| 7 | Native base64 encode of the response | CPU, allocation | all native |
| 8 | **Response embedded in JS source and evaluated**: the webview lexes and parses a script as large as the payload | dominant for large payloads and streams | all native |
| 9 | JS base64 decode | CPU, allocation | `bridge/base64.ts` |

Threading and contention:

- **Apple**: `coreCall` runs on the main thread under a global `NSLock` (`platform/apple/FullStacked/Core.swift`, `WebView.swift:196`). Static-file serving also runs `coreCall` on the main thread.
- **Windows**: `WebMessageReceived` runs the core call on the UI thread.
- **GTK**: the script message handler runs on the GTK main loop.
- **Android**: `@JavascriptInterface` blocks the JS thread for the whole Go call, even for "async" calls. Only the response delivery is async.
- **Streams**: every chunk is an `evaluateJavaScript` hop to the main thread. Nothing is batched and there is no backpressure.

Correctness issues found along the way (they also hurt performance under load):

- The JS request id wraps at 256 (`bridge/index.ts`, `id = (id + 1) % 256`). With more than 255 calls in flight, ids collide and the core rejects them with "id already in use".
- Platform-originated calls on Windows and Linux use request id `0` (`Core.cs` `deepLink`, `core.cpp` `deepLink`), so they can collide with JS calls.
- `router.Call` reads `store.Contexts[ctxId]` without `ctxMutex`, which is a data race with `NewContext` and `EndContext`.
- Workers relay through the main thread with structured clone. The `postMessage(payload, { targetOrigin })` option is ignored in workers, so the buffer is copied, not transferred.

---

## 4. Benchmarking via Shell & Reporting Guide

Rather than relying on one-off baseline measurements, each platform is benchmarked manually via the FullStacked shell across optimization stages.

### 4.1. Architecture: FullStacked and the `./shell` Submodule

FullStacked embeds `./shell` (a git submodule and npm workspace) as the universal interactive interface and terminal app across all platforms:

- **Packaging:** During the build process, `./shell` is bundled into `shell/out`, which is distributed directly inside every platform host (Apple macOS/iOS app bundles via Xcode, Android via Gradle assets, Windows via WebView2, Linux via `/usr/share/fullstacked/app`, and Node).
- **Execution Environment:** In-app terminal commands run within the FullStacked JavaScript runtime, with full access to Node.js compatibility APIs (`os`, `fs`, `path`, `process`) and the bridge to the Go core.
- **Command Registration:** Commands implement the `Command` interface in `shell/cli/types.ts` and are registered in `shell/cli/index.ts`. Terminal output is streamed via `shell.write()` / `shell.writeln()` directly to xterm.js.

### 4.2. How the `bench` Command Works

The `bench` command (added to `./shell` in Stage 1) is designed for cross-platform manual execution:

1. **Self-Detecting Environment Metadata:**
   The command automatically detects the host environment without requiring manual flags:
   - **FullStacked Version & Git Commit:** Retrieved from `(process.versions as any).fullstacked`, which exposes `{ major, minor, patch, build, branch, hash }`. The short commit hash `hash.substring(0, 8)` is recorded automatically.
   - **OS & Architecture:** Retrieved directly via `os.platform()` (e.g. `darwin`, `linux`, `win32`, `android`) and `os.arch()`.
   - **Timestamp:** Recorded via `new Date().toISOString()`.

2. **Live Progress in Terminal:**
   While executing benchmark suites (`noop`, `echo`, `concurrent`, `stream`, `fs`), `bench` writes real-time progress and interim latency/throughput figures directly to the terminal using `shell.writeln()`.

3. **Default Output File (`output.json`):**
   By default, upon completion `bench` writes the complete benchmark report to `output.json` in the current working directory (`fs.writeFileSync("output.json", ...)`). An optional `-o, --output <path>` flag allows specifying an alternate destination.

#### CLI Usage & Options

```sh
bench -n 200 -s 1k,64k -t 4m -k 4k,256k -r 2
```

| Flag | Description | Default / Example |
|---|---|---|
| `-n, --iterations` | Number of iterations per benchmark case | `200` |
| `-s, --sizes` | Comma-separated payload sizes for echo tests | `1k,64k` |
| `-t, --total` | Total bytes transferred in streaming benchmarks | `4m` |
| `-k, --chunks` | Comma-separated chunk sizes for stream tests | `4k,256k` |
| `-r, --runs` | Number of repeated runs to average | `2` |
| `-o, --output` | Output JSON file path | `output.json` |
| `--suites` | Specific suites to run (`noop`, `echo`, `concurrent`, `stream`, `fs`, `worker`) | all |
| `--sync-only` | Run synchronous suites only | flag |
| `--async-only` | Run asynchronous suites only | flag |

### 4.3. Reporting Results to the Repository

Benchmark results from manual runs are stored as JSON files under the `perfs/bench/` directory following this path pattern:

```
perfs/bench/[STAGE]-[COMMIT_HASH]/[PLATFORM].json
```

#### Path Variables

- **`[STAGE]`**: Optimization stage identifier:
  - `stage1` (Baseline measurement before optimizations)
  - `stage2` (Cheap wins: copy removal, off-UI thread, lock fixes)
  - `stage3` (Binary streaming responses)
  - `stage4` (Binary request path)
  - `stage5` (Hybrid transport: messages for small calls, POST and frames for large payloads)
  - `stage6` (Packaging: thin hosts, porting guide)
- **`[COMMIT_HASH]`**: Short git commit hash of the code being evaluated (e.g. `5ffcd9c6` from `git rev-parse --short HEAD` or `process.versions.fullstacked.hash`).
- **`[PLATFORM]`**: Target platform name:
  - `apple-macos`
  - `apple-ios`
  - `android`
  - `windows`
  - `linux-gtk`
  - `linux-qt`
  - `node`

#### Directory Layout Example

```
perfs/bench/
├── stage1-5ffcd9c6/
│   ├── android.json
│   ├── apple-ios.json
│   ├── apple-macos.json
│   ├── linux-gtk.json
│   ├── linux-qt.json
│   ├── node.json
│   └── windows.json
└── stage2-7a8b9c0/
    ├── ...
```

#### JSON Output Schema (written to `output.json`)

```json
{
  "meta": {
    "commit": "5ffcd9c6",
    "platform": "darwin",
    "arch": "arm64",
    "fullstackedVersion": "1.0.0-alpha.1810",
    "timestamp": "2026-10-08T02:50:00Z",
    "options": {
      "iterations": 200,
      "echoSizes": ["1k", "64k"],
      "streamTotal": "4m",
      "streamChunks": ["4k", "256k"],
      "runs": 2
    }
  },
  "results": [
    {
      "suite": "noop",
      "name": "noop sync",
      "meanMs": 2.06,
      "p95Ms": 3.00,
      "opsPerSec": 486
    },
    {
      "suite": "noop",
      "name": "noop async",
      "meanMs": 1.91,
      "p95Ms": 2.60,
      "opsPerSec": 523
    },
    {
      "suite": "echo",
      "name": "echo sync 64k",
      "meanMs": 7.21,
      "p95Ms": 9.40,
      "opsPerSec": 139,
      "mbPerSec": 17.3
    },
    {
      "suite": "echo",
      "name": "echo async 64k",
      "meanMs": 4.50,
      "p95Ms": 7.50,
      "opsPerSec": 222,
      "mbPerSec": 27.8
    },
    {
      "suite": "concurrent",
      "name": "concurrent noop x32",
      "opsPerSec": 1449
    },
    {
      "suite": "stream",
      "name": "stream 4m / 4k chunks",
      "durationMs": 73.8,
      "chunksPerSec": 13875,
      "mbPerSec": 54.2
    },
    {
      "suite": "stream",
      "name": "stream 4m / 256k chunks",
      "durationMs": 39.5,
      "chunksPerSec": 406,
      "mbPerSec": 101.0
    },
    {
      "suite": "fs",
      "name": "readFileSync 64k",
      "meanMs": 3.87,
      "p95Ms": 5.40,
      "opsPerSec": 258,
      "mbPerSec": 16.1
    }
  ]
}
```

### 4.4. Manual Testing Workflow per Platform

For each platform:
1. Check out the stage branch / commit to evaluate.
2. Launch FullStacked on the target platform or device.
3. In the FullStacked shell, execute:
   ```sh
   bench -n 200 -s 1k,64k -t 4m -k 4k,256k -r 2
   ```
4. Follow live benchmark progress in the terminal.
5. When complete, `output.json` is generated in the working directory with all results and auto-detected metadata.
6. Move or copy `output.json` into the repository under the appropriate stage and platform name:
   ```sh
   mkdir -p perfs/bench/[STAGE]-[COMMIT_HASH]
   mv output.json perfs/bench/[STAGE]-[COMMIT_HASH]/[PLATFORM].json
   ```
   *(Or specify the output file directly via `bench ... -o perfs/bench/[STAGE]-[COMMIT_HASH]/[PLATFORM].json`).*
   On a device (iOS, Android) or any host where the repository isn't the working directory, upload the file to your machine with `curl` instead (see 4.5).
7. Commit the resulting JSON file(s) to git to record benchmark history for that stage.

### 4.5. Getting `output.json` off a Device with `curl`

The shell's `curl` command follows the Unix `curl` arguments for uploads, so `output.json` can be sent to any server on the LAN that accepts POST or PUT uploads:

| Option | Request |
|---|---|
| `-F, --form name=@file` | `POST` `multipart/form-data`, `name=@file;type=mime;filename=name` also supported |
| `--data-binary @file` | `POST` with the raw file as the body |
| `-d, --data @file` | `POST` `application/x-www-form-urlencoded`, CR/LF stripped like curl (avoid for JSON) |
| `-T, --upload-file file` | `PUT` with the raw file, the file name is appended when the URL ends with `/` |

Requests go through the Go core's `fetch`, so platform rules for plain-HTTP traffic (iOS ATS, Android cleartext) don't apply. On iOS, accept the Local Network permission prompt the first time.

**1. Start the receiver on your machine** from the repository root:

```sh
node perfs/server.ts
```

It listens on port `8000` (or `node perfs/server.ts <port>`), logs the private LAN IP(s) to use, and saves each upload under `perfs/bench/` at the request path. Only JSON bodies are accepted. Raw bodies (`--data-binary`, `-T`) and multipart file parts (`-F`) both work.

**2. Upload from the FullStacked shell on the device**, using the stage, commit and platform as the path:

```sh
curl --data-binary @output.json http://192.168.1.10:8000/stage1-5ffcd9c6/android.json
```

or with `PUT`, or as a multipart form:

```sh
curl -T output.json http://192.168.1.10:8000/stage1-5ffcd9c6/android.json
curl -F file=@output.json http://192.168.1.10:8000/stage1-5ffcd9c6/android.json
```

The file lands in `perfs/bench/stage1-5ffcd9c6/android.json`, ready to commit.

---

## 5. Target architecture: one transport

```
POST  fs://call            binary body → binary response          async (fetch)
POST  fs://sync            binary body → binary response          sync XHR (workers: arraybuffer)
GET   fs://stream/{ctx}    long-lived streaming response          all stream chunks for a context, framed [streamId, flags, len, bytes]
GET   fs://platform, fs://ctx, everything else → static file
```

Properties:

- **No base64 and no `evaluateJavaScript` on the data path.** Requests and responses are raw bytes. Stream data arrives through `response.body.getReader()`.
- **Off the UI thread.** The scheme handler dispatches to a worker queue, calls the core, and responds. Contexts no longer serialize behind a global lock.
- **Sync is a single hop.** The handler has the body, so the postMessage-then-XHR dance and the awaiter maps go away.
- **One JS platform bridge.** `node.ts` already has this shape. `apple.ts`, `android.ts`, `windows.ts`, and `linux.ts` are deleted, along with the `respond` and `onStreamData` globals.
- **Workers call the transport directly** (fetch and XHR work in workers), so the main-thread relay in `worker_threads` goes away.
- **Optional:** move the routing into Go with one export, `handleRequest(method, path, body, len) → (status, mime, ptr, len)`. Each host then only forwards requests and knows nothing about the protocol, which is what makes "package into an app easily" true.

Per-platform mechanism and caveats:

| Platform | Request in | Response / stream out | Caveat |
|---|---|---|---|
| Apple | `WKURLSchemeHandler`, `request.httpBody` | `urlSchemeTask.didReceive(data)` repeatedly, `didFinish` at end | `httpBody` works for custom schemes, `httpBodyStream` does not. Call `urlSchemeTask` on the main thread: compute off-thread, respond on main. |
| Android | `shouldInterceptRequest` **does not expose POST bodies** | `WebResourceResponse` with a blocking `InputStream` (streaming works) | For requests, use `androidx.webkit` `WebViewCompat.addWebMessageListener` with `WebMessageCompat` `TYPE_ARRAY_BUFFER` (feature `WEB_MESSAGE_ARRAY_BUFFER`). It is binary both ways and replies via `JavaScriptReplyProxy.postMessage(byte[])`. Keep `@JavascriptInterface` for main-thread sync. |
| Windows | `WebResourceRequested`, `Request.Content` | `CreateWebResourceResponse` with an `IStream` | Confirm that WebView2 delivers a custom `IStream` incrementally. If it buffers, use `PostSharedBufferToScript` for large pushes (zero-copy). |
| Linux GTK | `webkit_uri_scheme_request_get_http_body` (WebKitGTK ≥ 2.40) | `webkit_uri_scheme_request_finish` with a `GInputStream` | Check the minimum WebKitGTK version shipped by target distros. |
| Linux Qt | `QWebEngineUrlRequestJob::requestBody()` (Qt ≥ 6.7) | `job->reply(mime, QIODevice*)` with a sequential device | Drop QWebChannel from the data path. |
| Node | already HTTP | already streaming-capable | Replace the WebSocket with the same `GET /stream/{ctx}` framing to unify. |

Constraint to keep in mind: per spec, a main-thread sync XHR cannot set `responseType = "arraybuffer"`. Options are `overrideMimeType("text/plain; charset=x-user-defined")` for a binary-safe string, or keeping base64 for main-thread sync only. Workers are unrestricted. Sync calls should become rare once async is cheap.

---

## 6. The five stages

Each stage is measured with `bench` on every platform before and after. A stage is done when its exit criteria hold on all platforms.

### Stage 1: Measure

**Goal:** a reproducible baseline per platform, so later stages are judged on numbers.

- Add `BenchEcho` (payload echo) and `BenchStream` (total and chunk size, closable) to the core `Test` module.
- Add the `bench` command to the `./shell` submodule (`shell/cli/bench.ts`). The command auto-detects `process.versions.fullstacked` and `os.platform()`, streams live progress to the terminal, and writes results by default to `output.json` (supporting suites `noop`, `echo`, `concurrent`, `stream`, and `fs`, with options `-n`, `-s`, `-t`, `-k`, `-r`, `-o`, `--suites`, `--sync-only`, `--async-only`).
- Run it manually on Apple (macOS, iOS), Android, Windows, Linux GTK, Linux Qt, and Node. Store the JSON output per platform in the repo at `perfs/bench/stage1-[COMMIT_HASH]/[PLATFORM].json`.
- Add a `worker` variant of the suites, because workers take a different path today.

**Exit:** baseline JSON for every platform, committed under `perfs/bench/stage1-[COMMIT_HASH]/`.

### Stage 2: Cheap wins (no protocol change)

**Goal:** remove obvious waste while keeping the transport as is.

- `core/main.go`: replace `C.CBytes` + `write_bytes_array` + `C.free` with a single `copy(unsafe.Slice((*byte)(ptr), int(size)), response)`.
- Run `coreCall` off the UI thread on Apple, Windows, and GTK. Dispatch to a background queue and deliver the result on the main thread. Drop the global `coreCallLock` on Apple, because the core is already safe with per-context mutexes.
- Fix the `router.Call` race: read `store.Contexts` under `ctxMutex`.
- Fix request ids:
  - Use a per-context id allocator, or widen the header id to 16 bits. That needs a protocol version byte.
  - Never use id `0` from the host (Windows and Linux `deepLink`).
  - Reject or queue calls in JS beyond 255 in flight instead of colliding.
- Batch stream chunks per event-loop tick on the native side before one `evaluateJavaScript`.
- Use native `Uint8Array.prototype.toBase64` / `fromBase64` where available, with the current code as a fallback.
- In workers, use `postMessage(buffer, [buffer])` (transfer instead of copy).

**Exit:** no regressions on any suite; stream and concurrent suites improve on Apple, Windows, and GTK; no id collisions at `-c 255`.

**Implementation notes:**

- The `call` + `getCorePayload` merge (listed in Stage 4) was pulled into this stage as `callWithResponse(buffer, length, *size) → ptr`, freed with `freePtr`. Responses are no longer stored by request id, so host calls (static files, deeplinks) and JS calls can run concurrently without colliding, which is what makes removing the Apple lock safe. Every native host (Apple, Android, Windows, Linux GTK/Qt) uses it; Node keeps `call` since it runs on one thread. `getCorePayload` remains for stream chunks, with the single `copy`.
- Off the UI thread uses a **serial queue per webview** (Apple `DispatchQueue`, Windows chained `Task`, GTK `GThreadPool` of one thread), not a concurrent pool: calls from one JS context keep their order (e.g. successive `Stream.Write` on a socket), contexts run in parallel. Static files go to a concurrent queue. Results are delivered on the UI thread. Qt and Android keep their current threading.
- JS request ids are allocated in `bridge/ids.ts`: ids 1-255, skipping those in flight, async calls queue beyond 255 in flight, sync calls throw. The worker relay allocates main-thread ids for worker async calls and posts worker sync calls with `Send`.
- Stream chunks are batched on Apple, Android, Windows, GTK and Qt: chunks received before the UI thread runs are evaluated in one script.
- The native base64 decode path never ran (`fromBase64` is static on `Uint8Array`, not on its prototype); fixed with a fallback to the JS decoder for URL-safe input.
- `EndContext` closes streams outside the locks and skips streams without `Close`; Linux `App::activeWindows` is guarded for the stream callback.
- Windows: the `CoreWebView2` is kept in a field of the window. CsWinRT drops the event handlers of a collected projection, so after a GC `WebResourceRequested` stopped firing (requests fell through to the network with `ERR_CONNECTION_REFUSED`, blank window) or crashed with an `AccessViolationException` in `Application.Start`. Stage 1 got lucky with GC timing; Stage 2's allocations made it reproducible.
- Windows sync: the `/sync/{id}` handler takes the response or registers its awaiter under one lock. With core calls off the UI thread, the response could land between the check and the registration and leave the sync XHR waiting forever.

**Results** (`stage1-f63299e9` → `stage2-34251cd0`):

- Streams: 1.6-1.8× on Apple (macOS 4k 251 → 404 MB/s, 256k 686 → 1167 MB/s; iOS 4k 1.8×), Windows 4k 1.5× but 256k 0.8×, GTK, Qt and Android flat.
- 64k echo: 1.1-1.3× on Apple and Windows sync, 1.3-1.5× on Android. Android also gains on concurrent (2.25×) and readFileSync 1k (4.6×), once static files and calls stopped colliding.
- Small calls are 5-15% slower on Apple, Windows and GTK (iOS noop async 0.58×): the extra thread hop costs more than the call.
- Concurrent regressed on GTK (0.47×), macOS (0.78×) and Windows (0.84×), so the exit criteria are not met. Causes: GTK posted results at idle priority, which waits while messages keep coming, and every response was its own main thread hop and script evaluation. Fixed with Stage 3: results come back at default priority on GTK, and responses join the batched script of the tick on Apple, Windows and GTK, each statement wrapped in `try` so one failing callback does not drop the rest of the batch.

### Stage 3: Binary streaming responses

**Goal:** take stream data off `evaluateJavaScript`. This is the largest single win: per-chunk cost drops and backpressure comes for free.

- Add `GET fs://stream/{ctx}` on every platform: one long-lived response per context, framed `[streamId u8][flags u8][len u32][bytes]`.
- Go: `OnStreamData` writes frames to a per-context queue drained by the host's response stream, replacing a pull per chunk.
- JS: one reader loop that dispatches frames to `duplex.ts`. Remove the `onStreamData` global and its base64 path.
- Android: `WebResourceResponse` backed by a `PipedInputStream`. Windows: `IStream`. GTK: `GInputStream`. Qt: sequential `QIODevice`. Apple: repeated `didReceive`.

**Exit:** `stream` suite MB/s within 2× of Node on every platform, and the 4k-chunk suite no longer bound by per-chunk script evaluation.

**Implementation notes:**

- Go: `internal/frames` keeps a frame queue per context. The host calls `streamAttach(ctx) → gen`, then `streamRead(ctx, gen, *size)` in a loop on its own thread: it blocks until frames are queued and returns all of them (whole frames, freed with `freePtr`), nil once the context ends, the page reloads (a new attach) or `streamDetach(ctx, gen)`. While a reader is attached, `StreamChunk`/`StreamError` push frames instead of calling `setOnStreamData`, ended streams are dropped right away, and producers wait while 8 MB are queued (backpressure). Without a reader, the per chunk callback still applies (Node, fallback).
- The path is `GET /stream` (the context is the one of the page) and stream id 0 is a hello frame queued on attach. JS waits for it up to 3 s before making calls: without it (a webview buffering the response) it aborts the request, the host detaches and stream chunks keep coming through `window.fullstacked.onStreamData`, which stays registered for that fallback and for Node.
- Apple: `didReceive` per read from a reader thread, delivered on the main thread, `stop` detaches. Android: `WebResourceResponse` with an `InputStream` reading `streamRead` directly (no pipe), `close` detaches. GTK: a socket pair, WebKit reads one end as a `GUnixInputStream`, the reader thread writes the other (a failed write detaches). Qt: a sequential, unbuffered `QIODevice` owned by the job, appended on the main thread and read by QtWebEngine on its IO thread, so its buffer is locked; it detaches when deleted.
- Windows: WebView2 requires the response stream to hold the whole body when the request completes, so a long-lived response cannot stream. The reader thread posts the frames with `PostSharedBufferToScript` instead (binary, no base64, no script evaluation), the page parses them the same way.
- WebKit (and apparently Android WebView) holds the tail of a streaming custom-scheme response until more bytes arrive, which stalled the first stream after `concurrent noop x32` on macOS. Once the queue goes idle after data, `frames.Queue.Read` returns empty keepalive frames (stream 0) after 1, 10, 100 and 500 ms to push the tail through.
- Android never got the hello frame, so it always fell back (`streamTransport: evaluated`), and the fallback lost data (`received 1925120 bytes, expected 4194304`). Chromium reads an intercepted `InputStream` on its own thread ([input_stream_reader.cc](https://raw.githubusercontent.com/chromium/chromium/main/components/embedder_support/android/util/input_stream_reader.cc), [android_stream_reader_url_loader.cc](https://raw.githubusercontent.com/chromium/chromium/main/components/embedder_support/android/util/android_stream_reader_url_loader.cc)): it takes the response length from the first `available()` call (0 makes `Content-Length: 0`), then sizes each read buffer from `available()` and reads until that buffer is full. In the page, the headers arrived after 12 ms but no byte of the body in 4 s, while the host had handed it 2 KB. The `InputStream` now reports `Int.MAX_VALUE` to the first call, then blocks until frames are queued and reports exactly their size, so each read returns the frames as they come. Since the length is fixed, it ends the response between two batches after 1 GB, still attached: the page reconnects and `Attach` keeps the queued frames (always whole frames) for the new response. The response is typed `application/x-fullstacked-frames` with `nosniff`.
- Fallback: the host stayed attached after the page gave up on the hello frame until the WebView closed the stream, so stream chunks went to frames nobody read before reaching the evaluated path. The page now calls `GET /stream/detach` and waits for it before making calls, every host routes it to `streamDetach(ctx, 0)` (0: the current reader).
- The page reconnects `GET /stream` when the response ends or fails after the hello frame.
- Android, on device, 2 full runs after the fix: `streams: frames`, no stall, 4k stream 103-104 MB/s and 256k 131-143 MB/s (Stage 1: 27 and 38 MB/s).
- Node reads `GET /stream` too (native `streamStart` with a reader thread) and keeps the WebSocket as fallback.
- `bench` prints `streams: frames|shared-buffers|evaluated|websocket` in its header, saved as `meta.streamTransport`.

**Linux** (arm64 VM, Debian 13, WebKitGTK 2.52, Qt 6.8.2):

- CMake: `ARCH` now defaults to the host architecture and is not kept in the cache, and configuring fails when the cached compilers build for another architecture than `ARCH`, instead of silently building for it. A cross build directory has to be configured with `-DARCH` again (`publish.js` deletes the cache each time).
- Qt bug: QtWebEngine reads the `/stream` device on its IO thread while frames were appended on the main thread, without a lock. The `QByteArray` race duplicated and dropped bytes (instrumented: 12.84 MB read for 12.60 MB appended), the page's parser lost a frame: `received 4190208 bytes, expected 4194304` when it was data, a stall on the first stream after `concurrent noop x32` when it was the end frame. Fixed by locking the buffer and opening the device unbuffered. 6 full runs and 3 runs of `bench -n 50 -t 64m -k 1k,4k,64k,1m -r 3 --suites concurrent,stream` passed afterwards.
- GTK: 6 full runs and the same 3 stress runs, all on `streams: frames`, no stall and no error (with the keepalive frames; GTK was not tried without them).
- Qt: `QWebEngineUrlScheme::FetchApiAllowed` is guarded with `QT_VERSION_CHECK(6, 6, 0)` for Ubuntu 24.04 (Qt 6.4).
- Qt call path: Qt is the fastest Linux host on payloads (64k echo 1.8 ms, GTK 3.0 ms) and at par on async noop (0.23 ms medians for both). Only sync calls cost more (noop 0.40 ms against 0.18 ms on GTK): the postMessage over QWebChannel plus the XHR to `/sync/{id}`, which Stage 4's single-hop `POST fs://sync` removes (`QWebEngineUrlRequestJob::requestBody` with Qt ≥ 6.7, keeping the current path below 6.7). Moving async responses to frames or batching them was not worth a protocol change for these numbers.

**Results** (`stage3-f7a070a7`, Linux, medians of 6 runs; saved files are the run closest to the median):

| Case | GTK s2 | GTK s3 | Qt s3 |
|---|---|---|---|
| noop sync | 0.21 ms | 0.18 ms | 0.40 ms |
| noop async | 0.17 ms | 0.23 ms | 0.23 ms |
| echo sync 64k | 2.83 ms | 3.01 ms | 1.86 ms |
| echo async 64k | 3.01 ms | 3.55 ms | 1.74 ms |
| concurrent noop x32 | 29k ops/s | 32k ops/s | 41k ops/s |
| stream 4m / 4k | 65 MB/s | 216 MB/s | 321 MB/s |
| stream 4m / 256k | 70 MB/s | 238 MB/s | 392 MB/s |
| stream 64m / 1k-1m (stress) | | 370-570 MB/s | 490-810 MB/s |

- Streams: 3.3× on GTK. The 4 MB cases last 10-20 ms and vary ±40% from run to run; 64 MB streams are steadier.
- Against Node in Stage 2 (164 MB/s at 4k, 800 MB/s at 256k): 4k is above Node on both hosts; 256k is 3.4× below on GTK and 2× below on Qt at 4 MB, and 1.4-2.2× (GTK) and 1-1.6× (Qt) below at 64 MB. Node has no Stage 3 run on this machine yet.
- GTK small async calls are about 0.06 ms slower than in Stage 2 (noop async 0.17 → 0.23 ms, echo async 1k 0.24 → 0.29 ms), not investigated.

### Stage 4: Binary request path

**Goal:** remove base64 and `evaluateJavaScript` from the call and response paths.

- `POST fs://call` (async) and `POST fs://sync` (sync) with raw bodies on Apple, Windows, GTK, and Qt. Handlers run off the UI thread.
- Android: `addWebMessageListener` with ArrayBuffer messages for async calls. Keep `@JavascriptInterface` for main-thread sync. Gate on `WebViewFeature.isFeatureSupported` and fall back to the current path.
- Delete the `/sync/{id}` awaiter machinery (`syncAwaitersResolve` and `syncAwaitersPayload`) from Swift, Kotlin, C#, GTK, and Qt.
- ~~Merge `call` and `getCorePayload` into one export~~ (done in Stage 2 as `callWithResponse`).

**Exit:** `echo` suite MB/s at 64k and 1m improves on every native platform. `noop` latency is at or below Node's.

**Implementation notes:**

- JS: `bridge/platform/transport.ts`. `postCall` posts the payload to `POST /call` with the native `fetch` (captured before the bridge replaces it) and returns the response body. `postSync` posts it with a sync XHR to `POST /sync`; a page cannot ask a sync XHR for an `arraybuffer`, so it reads the response as `text/plain; charset=x-user-defined` (one char per byte), workers read an `arraybuffer`. No base64 and no evaluated script on either path.
- Apple, Windows and GTK always serve them, Qt from 6.7 (`QWebEngineUrlRequestJob::requestBody`). `GET /bridge` answers `binary` (or `message` on Qt < 6.7, which keeps the QWebChannel messages and the `/sync/{id}` awaiters). Apple reads `request.httpBody`, Windows `Request.Content`, GTK `webkit_uri_scheme_request_get_http_body` (WebKitGTK 6.0).
- Qt (6.8) body device: it is handed over closed (`readAll` failed with "device not open", the core got an empty payload: `received empty response` at launch), its `size` is 0 and `atEnd` true, and past a first read a read restarts from the start of the body and only ends once the bytes read add up to the body size. A body read in chunks came back wrong (1 MB and up), or without end when its size is not a multiple of the read size, so `readAll` grew until the machine ran out of memory (the freeze in the `echo` suite at 64k). No `Content-Length` reaches the handler: the page sends `X-Body-Size` with `POST /call` and `/sync` (other hosts ignore it) and Qt reads the body in one read of that size, failing the request when it is missing or short. Echo checked byte for byte from 1 B to 32 MB, sync and async.
- The calls of a page run in arrival order on the per webview serial queue of Stage 2 (Apple `DispatchQueue` now in `RequestHandler`, Windows chained tasks awaited by the request deferral, GTK `GThreadPool` of one thread, Qt `QThreadPool` of one thread), the response is sent on the UI thread.
- Deleted on Apple, Windows and GTK: the `bridge` script message, `window.fullstacked.respond`, the `/sync/{id}` awaiters and the `Send` of the worker relay.
- Workers: async calls still go through the main thread (`relayCall`), which records the streams they open to hand them their frames (a worker has no `/stream` reader). Sync calls of a worker post `POST /sync` themselves (a stream opened by a sync call of a worker was not forwarded before either).
- Android: `shouldInterceptRequest` has no request body. Async calls are posted to a `WebViewCompat.addWebMessageListener` object (`fullstackedBridge`, origin `http://localhost`, main frame) as `ArrayBuffer` and answered `[id][response]` through the `JavaScriptReplyProxy`, run in order on a single thread executor per webview. Gated on `WEB_MESSAGE_LISTENER` and `WEB_MESSAGE_ARRAY_BUFFER` (androidx.webkit 1.14.0), otherwise the page keeps `android.coreCall`. Sync calls of the page stay on `@JavascriptInterface`; workers keep the relay and `/sync/{id}`, so the Kotlin awaiters stay for them.

**Results** (`stage3-569565cc` → `stage4-2fa81d65`):

| | noop async | concurrent x32 | echo async 64k | readFile 64k |
|---|---|---|---|---|
| macOS | 0.065 → 0.112 ms | 100k → 25k ops/s | 0.26 → 0.19 ms | 0.17 → 0.18 ms |
| iOS | 0.135 → 0.223 ms | 36.7k → 13.8k ops/s | 0.47 → 0.35 ms | 0.34 → 0.46 ms |
| Android | 0.44 → 1.02 ms | 2.5k → 3.7k ops/s | 7.3 → 3.1 ms | 6.1 → 3.5 ms |
| GTK | 0.163 → 0.185 ms | 83k → 34k ops/s | 2.88 → 0.36 ms | 1.13 → 0.31 ms |
| Windows | 0.38 → 2.11 ms | 25.3k → 985 ops/s | 3.3 → 4.8 ms | 2.6 → 4.6 ms |
| Qt (6.7+) | 0.185 → 0.374 ms | 45.4k → 8.3k ops/s | 3.63 → 0.74 ms | 1.32 → 0.52 ms |
| Node | 0.575 → 0.587 ms | 2.1k → 3.0k ops/s | 1.85 → 0.75 ms | 0.86 → 0.80 ms |

- Large payloads win where the request path is cheap: GTK 64k echo 8×, Qt 4.9×, Android 2.4×, macOS 1.4×, file reads 3.6× on GTK, 2.5× on Qt, 1.7× on Android.
- Every async call is now its own custom-scheme request, whose fixed cost is larger than a small message: small async calls are slower on every platform and concurrency dropped on Apple, GTK and Qt (Android gained, its old path blocked the JS thread for the whole call).
- Windows regressed on everything async: `WebResourceRequested` costs ~1.8 ms per request with little parallelism (the browser process calls into the app's UI thread through COM and a deferral), more than base64 and script evaluation cost even at 64k. Sync calls stayed where they were (~2 ms), they already went through it.
- Streams are unchanged (Stage 3 path). Node did not change in this stage (it already posted its calls), its differences are run to run variation.
- Exit criteria: 64k echo improves on every native platform except Windows; `noop` latency stays below Node's (0.575 ms) everywhere except Windows and Android.
- This led to the revised Stage 5 below.

### Stage 5: Hybrid transport (revised)

**Why revised:** Stage 4 put every async call on its own custom-scheme request. Large payloads won (64k echo 8× on GTK, 2.4× on Android, file reads 2-3.6×), but each request carries a fixed cost that is larger than a small message: small async calls got slower everywhere (macOS noop 0.065 → 0.112 ms, Android 0.44 → 1.02 ms) and so did concurrency (macOS 100k → 25k ops/s, GTK 83k → 34k). On Windows `WebResourceRequested` costs ~1.8 ms per request with little parallelism, so even 64k lost (noop 0.38 → 2.11 ms, concurrent 25k → 985 ops/s). The original Stage 5 unified on that path and would have kept the regression.

**Goal:** pick the path per call so small calls pay the least fixed cost and large payloads move as raw bytes.

- **Small requests on a message channel** whose reply needs no script evaluation:
  - Apple: `WKScriptMessageHandlerWithReply`, the page awaits `webkit.messageHandlers.call.postMessage(base64)`.
  - GTK: `webkit_user_content_manager_register_script_message_handler_with_reply`, same JS.
  - Windows: `chrome.webview.postMessage(base64)`, replies posted back with `PostWebMessageAsString`, batched per UI tick.
  - Android: `@JavascriptInterface` hands the call to the core thread and returns at once, the reply is posted as an `ArrayBuffer` through the `JavaScriptReplyProxy` of the web message listener.
- **Large requests** (16 KB and up) keep `POST /call` (Android: an `ArrayBuffer` message), except on Windows where POST lost at every size.
- **Large responses on `/stream`:** the request does not predict the response size (`readFile` posts a few bytes and gets 64 KB back). `callMessage` is a core export like `callWithResponse`: when the response is 16 KB or more and a frame reader is attached, it queues it as a response frame (`[callId][3][len][response]`) and the message reply is empty; otherwise the reply is the response. The page takes the response from whichever arrives.
- **Sync calls** stay on `POST /sync` (single hop, no regression anywhere).
- Qt: small requests on its QWebChannel message (its Stage 3 path, 0.185 ms noop against 0.374 ms posted), large ones posted (Qt ≥ 6.7). Node keeps its Stage 4 path.

**Exit:** small async calls and concurrency at or better than Stage 3 on every platform, 64k echo and file reads at or better than Stage 4.

**Implementation notes:**

- Core: `callMessage(buffer, length, *size)` (`router.CallForMessage`) processes a call received on a message channel. A response of 16 KB or more is queued as a response frame (flag 3, the frame id is the call id) when a frame reader is attached and `*size` is -1: the host replies empty. Errors come back as error responses, so an empty reply always means "on the frame stream".
- JS: `bridge/responses.ts` holds the response frames until the call takes them (the frame and the empty reply travel on different channels). `transport.ts` `hybridCall(messageCall, postMinSize)` sends requests under 16 KB on the message channel and posts larger ones; calls of both sizes can reach the host in another order than they were made, like any two calls not awaited in turn.
- Apple: `CallHandler` is a `WKScriptMessageHandlerWithReply` named `call`, the call runs on the `RequestHandler` core queue and the base64 reply resolves the page's `postMessage` promise.
- GTK: `call` is registered with `webkit_user_content_manager_register_script_message_handler_with_reply`, the reply is a `JSCValue` string returned on the main loop. The single-thread core pool now runs generic tasks for both POST and message calls.
- Windows: `chrome.webview.postMessage(base64)` → `WebMessageReceived` → core queue → replies batched per UI tick in one `PostWebMessageAsString("R<id>:<base64>;...")`. Every async call takes this path, POST lost at every size there. Sync calls stay on `POST /sync`.
- Qt: async messages over QWebChannel use `callMessage` (empty `respond` when framed); Qt ≥ 6.7 posts requests of 16 KB and more, older Qt sends everything as messages.
- Android: the page posts `init` to the web message listener so the host keeps its `JavaScriptReplyProxy`, then small calls go to `android.callAsync(base64)` (returns at once, the call runs on the core thread) and large ones are posted to the listener as an `ArrayBuffer`. Replies are `[id][response]` through the proxy, `[id]` alone when framed. Replying from the core thread instead of the UI thread made no difference (tried). Without the listener the page keeps the Stage 3 path.

**First runs** (macOS and Android measured here, the other platforms to bench):

| | Stage 3 | Stage 4 | Stage 5 |
|---|---|---|---|
| macOS noop async | 0.065 ms | 0.112 ms | 0.057-0.075 ms |
| macOS concurrent x32 | 100k | 25k | 75-83k ops/s |
| macOS echo async 64k | 0.26 ms | 0.19 ms | 0.20-0.22 ms |
| macOS readFile 64k | 0.17 ms | 0.18 ms | 0.14-0.15 ms |
| Android noop async | 0.44 ms | 1.02 ms | 0.65-0.68 ms |
| Android concurrent x32 | 2.5k | 3.7k | 2.7-3.0k ops/s |
| Android echo async 64k | 17 MB/s | ~42 MB/s | 45-48 MB/s |
| Android readFile 64k | 10.5 MB/s | ~19 MB/s | 28-30 MB/s |

- Android small async calls stay above Stage 3: Stage 3 ran the core call on the JavaBridge thread while the page waited, which blocked JavaScript for slow calls; the Stage 5 call returns at once and the reply goes through the proxy.

### Stage 6: Package

**Goal:** minimal per-platform glue, new platforms cheap to add.

- Collapse `bridge/platform/{apple,android,windows,linux,node}.ts` around the transport module and remove the `/platform` probe from the hot path.
- Move routing into Go with `handleRequest(method, path, body) → (status, mime, body)`. Hosts become thin adapters: load `libcore`, register one scheme handler and one message channel, forward requests.
- Drop the Node WebSocket once `/stream` covers every case.
- Write a short "porting guide" listing the adapter's responsibilities, and run `bench` in CI on the platforms that can run headless (Node, Linux GTK under Xvfb).

**Exit:** each native host's bridge code under about 150 lines; `bench` results committed for every platform, compared against `stage1-[COMMIT_HASH]`.

---

## 7. Expected impact (to be confirmed by Stage 1 numbers)

| Change | Affects | Expected effect |
|---|---|---|
| Remove the Go double copy | all | small, one alloc + copy per response/chunk |
| Core calls off the UI thread | Apple, Windows, GTK | UI stays responsive under load; better concurrency |
| Streaming responses instead of per-chunk `evaluateJavaScript` | all native | largest win for streams and small chunks; backpressure |
| Binary call path (no base64, no script eval) | all native | large win for payloads ≥ 64k; lower latency for small calls |
| Single-hop sync | Apple, Windows, Linux, Android workers | about half the IPC per sync call |
| Unified bridge | all | less code, one place to optimize, simpler porting |

## 8. Not recommended

- **Go → WASM in the webview**: it removes IPC but loses native fs, net, and git, so a host bridge would still be needed.
- **Loopback HTTP/WebSocket server on mobile**: it works on desktop (Node does this), but iOS suspends background sockets, and any local process could connect unless you add token and origin checks. The custom scheme gives the same binary and streaming properties without those problems.
