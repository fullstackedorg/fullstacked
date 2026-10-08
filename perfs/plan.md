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
  - `stage5` (Unified bridge & packaging)
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

### Stage 3: Binary streaming responses

**Goal:** take stream data off `evaluateJavaScript`. This is the largest single win: per-chunk cost drops and backpressure comes for free.

- Add `GET fs://stream/{ctx}` on every platform: one long-lived response per context, framed `[streamId u8][flags u8][len u32][bytes]`.
- Go: `OnStreamData` writes frames to a per-context queue drained by the host's response stream, replacing a pull per chunk.
- JS: one reader loop that dispatches frames to `duplex.ts`. Remove the `onStreamData` global and its base64 path.
- Android: `WebResourceResponse` backed by a `PipedInputStream`. Windows: `IStream`. GTK: `GInputStream`. Qt: sequential `QIODevice`. Apple: repeated `didReceive`.

**Exit:** `stream` suite MB/s within 2× of Node on every platform, and the 4k-chunk suite no longer bound by per-chunk script evaluation.

### Stage 4: Binary request path

**Goal:** remove base64 and `evaluateJavaScript` from the call and response paths.

- `POST fs://call` (async) and `POST fs://sync` (sync) with raw bodies on Apple, Windows, GTK, and Qt. Handlers run off the UI thread.
- Android: `addWebMessageListener` with ArrayBuffer messages for async calls. Keep `@JavascriptInterface` for main-thread sync. Gate on `WebViewFeature.isFeatureSupported` and fall back to the current path.
- Delete the `/sync/{id}` awaiter machinery (`syncAwaitersResolve` and `syncAwaitersPayload`) from Swift, Kotlin, C#, GTK, and Qt.
- ~~Merge `call` and `getCorePayload` into one export~~ (done in Stage 2 as `callWithResponse`).

**Exit:** `echo` suite MB/s at 64k and 1m improves on every native platform. `noop` latency is at or below Node's.

### Stage 5: Unify and package

**Goal:** one bridge implementation, minimal per-platform glue, and new platforms that are cheap to add.

- Collapse `bridge/platform/{apple,android,windows,linux,node}.ts` into one transport module and remove the `/platform` probe from the hot path.
- Move routing into Go with `handleRequest(method, path, body) → (status, mime, body)`. Hosts become thin adapters: load `libcore`, register one scheme handler, and forward requests.
- Move Node to the same `/stream/{ctx}` framing and drop the WebSocket.
- Write a short "porting guide" listing the adapter's responsibilities (about 100 lines per platform), and run `bench` in CI on the platforms that can run headless (Node, Linux GTK under Xvfb).

**Exit:** a single JS transport; each native host's bridge code under about 150 lines; `bench` results committed under `perfs/bench/stage5-[COMMIT_HASH]/` for every platform, comparing results against `stage1-[COMMIT_HASH]`.

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
