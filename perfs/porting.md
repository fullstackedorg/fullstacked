# Porting FullStacked to a new host

A host is a webview plus the Go core (`core/`, built as a static or shared
library with a C ABI). The page talks to the core through the host, with the
JS side in `core/internal/bundle/lib/bridge`. This guide lists what a host
implements, in the order to build it. The existing bridges are the reference:

| Host    | File                                             | Lines |
| ------- | ------------------------------------------------ | ----- |
| Apple   | `platform/apple/FullStacked/Core.swift`          | ~220  |
| Android | `platform/android/.../org/fullstacked/Bridge.kt` | ~220  |
| Windows | `platform/windows/Bridge.cs`                     | ~220  |
| GTK     | `platform/linux/src/gtk/bridge.cpp`              | ~215  |
| Qt      | `platform/linux/src/qt/bridge.cpp`               | ~250  |
| Node    | `platform/node/src/bridge.ts`                    | ~90   |

## 1. The core C ABI (`core/main.go`)

Lifecycle:

- `start(root, build) uint8` / `startSafe` / `startWithCtx`: a context, its id is the `ctx` of every other call.
- `check(ctx) bool`, `stop(ctx)`.
- `freePtr(ptr)`: frees every buffer the core returns.

Once at start:

- `setPlatform(name, binaryCalls)`: `name` is what `GET /platform` answers (informational, the page does not switch on it); `binaryCalls` is 1 when the host hands the body of `POST /call` and `/sync` to the core (see 2), 0 when the webview gives no request bodies (the page then sends every call on the message channel, see 3).
- `setOnStreamData(cb)` with `getCorePayload(ctx, 2, streamId, ptr, size)`: the per-chunk fallback for stream data while no frame reader is attached (see 4). Keep it: the page uses it until its `GET /stream` is up, and when it cannot read a streaming response.

Requests and calls:

- `handleRequest(ctx, path, body, length, *status, *size) ptr`: answers a request of the page, the buffer is `<mime type>\n<body>`. It serves `/platform`, `/ctx`, `/bridge`, `POST /call`, `POST /sync`, `/stream/detach` and the static files of the project (404 when not found).
- `callMessage(buffer, length, *size) ptr`: a call received on the message channel. The reply is the response, or `*size` is -1 and the reply is empty when the core queued a large response (16 KB and up) on the frame stream instead.
- `callWithResponse(buffer, length, *size) ptr`: a plain call with its response, for calls the host makes itself (deep links...).

Streams:

- `streamAttach(ctx) gen`: the caller becomes the reader of the stream frames of the context (-1 for an unknown context). A new attach (page reload) ends the previous reader.
- `streamRead(ctx, gen, *size) ptr`: blocks until frames are queued and returns them all (whole frames), `nullptr` once the reader ended. Call it from its own thread.
- `streamDetach(ctx, gen)`: ends the reader; `gen` 0 is the current one.

## 2. The requests of the page

Intercept every request of the page's origin (a custom scheme, a `WebResourceRequested` hook, or an HTTP server like Node) and route by path:

| Path                        | Who answers          | Threading                            |
| --------------------------- | -------------------- | ------------------------------------ |
| `GET /stream`               | the host (see 4)     | its own reader thread                |
| `/resize`, `/open`, `/exit` | the host (window UI) | main thread                          |
| `POST /call`, `POST /sync`  | `handleRequest`      | the serial core queue of the webview |
| everything else             | `handleRequest`      | any thread (a concurrent pool)       |

- Calls of one page run in order: keep one serial queue per webview for `/call`, `/sync` and the message channel, off the UI thread. Static files can run concurrently.
- Finish the response on the thread the webview expects (usually main).
- `POST /sync` is a synchronous XHR of the page: answer it like any request, the page waits.
- The page sends `X-Body-Size` with the body length for hosts whose body stream reports no size (Qt).
- Without the hello frame of `/stream` (see 4), the page calls `GET /stream/detach`: forward it to `handleRequest`, the core goes back to the per-chunk callback.

## 3. The message channel (small async calls)

Requests under 16 KB pay less on a message channel of the webview than on a request. Implement one when the webview has a reply-capable message API; otherwise set `binaryCalls` to 1 and the page posts every call (Node does this).

- The page sends the payload in base64; the host runs `callMessage` on the serial core queue and replies with the response in base64, or an empty string when the core framed it.
- Replies that go through an evaluated script or a posted message are cheaper batched once per main loop iteration (Windows, Android).
- JS side: a `messageCall(payload) => Promise<ArrayBuffer | null>` wrapped in `hybridCall` (`bridge/platform/transport.ts`), which posts the large requests and takes the framed responses from `responses.ts`.

Existing channels: `WKScriptMessageHandlerWithReply` (Apple), `register_script_message_handler_with_reply` (GTK), `chrome.webview.postMessage` + `PostWebMessageAsString` (Windows), `JavascriptInterface` + `WebMessageListener` reply proxy (Android), QWebChannel (Qt).

## 4. The frame stream (`GET /stream`)

Stream data (readable streams, stdout of commands, large responses) travels as binary frames on one long-lived response per page instead of a script evaluated per chunk (`core/internal/frames`).

- Frame: `[streamId u8][flags u8][length u32 BE][data]`; flags 0 data, 1 end, 2 error, 3 response of a call (the id is the call id).
- On `GET /stream`: `streamAttach`, answer with a streaming response, then a thread loops on `streamRead` and writes each batch to the response until it returns `nullptr`. The core queues a hello frame (stream 0, empty) first: the page switches to frames once it reads it, within 3 s, else it detaches and keeps the evaluated chunks.
- End the reader when the page goes away (the response write fails, the connection closes, the window closes): `streamDetach(ctx, gen)`.
- Webviews hold the tail of a streaming response until more bytes arrive: the core sends keepalive frames (stream 0, empty) after data, at 1 ms, 10 ms, 100 ms, 500 ms, and right away after a response frame. Nothing to do on the host.
- Backpressure: the core blocks producers past 8 MB queued while a reader is attached.
- A webview that cannot stream a response needs another channel for the frames: WebView2 gets them in shared buffers (`PostSharedBufferToScript`, `readFrameSharedBuffers` in `frames.ts`). Android fixes the response length (`available()`), so the host ends it every ~1 GB and the page reconnects, the core keeps the frames queued meanwhile.

## 5. The JS side: nothing per host

`bridge/platform.ts` is one file for every host. It does not ask the host who it is: it detects what the host offers and uses the requests for the rest.

- `GET /ctx` for the context, `GET /bridge` for whether the host reads request bodies.
- The message channel, in this order: `webkit.messageHandlers.call` (a WebKit handler with reply), `chrome.webview` (WebView2 web messages, replies `R<id>:<base64>;...`), `fullstackedBridge` + `fullstackedCore` (the Android listener and JavascriptInterface, with the `init`/`ready` handshake), `qt.webChannelTransport` + `bridge.postMessage(base64, callback)` (Qt, the reply is the return value of the method). None of them: every call is `POST /call`.
- Streams: `readFrameSharedBuffers` with `chrome.webview`, `readFrameStream` otherwise.
- UI: `/open?ctx=`, `/exit`, and `/resize` (`?size=` sets, no query gets); `window.resize`/`getSize` exist only when the host answers `GET /resize` with 200. The iOS clipboard is the one host-specific handler left (`webkit.messageHandlers.clipboard`).
- Workers: async calls through the main thread (`relayCall`), sync calls `POST /sync` directly, or through the main thread and `GET /sync/{id}` when the host reads no body.

A new host that serves the requests of section 2 needs no JS change. One that adds a message channel implements one of the four shapes above (the WebKit one is the simplest: a handler named `call` that replies with a string).

## 6. Checklist and bench

1. `setPlatform`, requests routed to `handleRequest`, the page loads (`/`, `/index.html`, `/ctx`, `/bridge`).
2. `POST /sync` and `POST /call` work: the shell starts.
3. `GET /stream` with the hello frame: `bench` reports `streamTransport: "frames"`.
4. A message channel for small calls (optional, see 3).
5. Bench with the shell (`perfs/plan.md`, section 4): `bench -n 200 -s 1k,64k -t 4m -k 4k,256k -r 2`, upload with `curl` to `node perfs/server.ts`, and commit the result under `perfs/bench/<stage>-<commit>/<platform>.json`. On Node, `node perfs/bench-node.ts -o node.json` runs it headless.

What to expect (Stage 5-6 numbers): small async calls 0.06-0.2 ms on desktop, 64k echo 0.2-0.8 ms, streams 500-3000 MB/s with 256k chunks. The fixed cost of a request through the webview (0.1-2 ms) dominates small calls, which is what the message channel is for.
