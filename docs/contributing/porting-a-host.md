# Porting to a new host

A host is a webview plus the Go core, built as a static or shared library with a C ABI. The page talks to the core through the host, with the JavaScript side in `core/internal/bundle/lib/bridge`. This page lists what a host implements, in the order to build it. Read [The bridge](../bridge.md) first.

The existing bridges are the reference:

| Host    | File                                                                  | Size       |
| ------- | --------------------------------------------------------------------- | ---------- |
| Apple   | `platform/apple/FullStacked/Core.swift`                               | ~220 lines |
| Android | `platform/android/studio/app/src/main/java/org/fullstacked/Bridge.kt` | ~220 lines |
| Windows | `platform/windows/Bridge.cs` (+ `Channel.cs`)                         | ~220 lines |
| GTK     | `platform/linux/src/gtk/bridge.cpp`                                   | ~215 lines |
| Qt      | `platform/linux/src/qt/bridge.cpp`                                    | ~250 lines |
| Node    | `platform/node/src/bridge.ts` (+ `gyp/bridge.cc`)                     | ~90 lines  |

## 1. The core C ABI (core/main.go)

**Lifecycle**

| Export                                      | Use                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `uint8 start(char* root, char* build)`      | Creates a context and returns its id, the `ctx` of every other call. `build` defaults to `<root>/out` when it equals `root`. |
| `uint8 startSafe(root, build)`              | The same, ignoring the `initialDirectory` config                                                                             |
| `void startWithCtx(root, build, uint8 ctx)` | Creates or replaces a context under a given id                                                                               |
| `int check(uint8 ctx)`                      | 1 if the context exists and hasn't exited                                                                                    |
| `void stop(uint8 ctx)`                      | Ends the context now                                                                                                         |
| `void freePtr(void*)`                       | Frees every buffer the core returns                                                                                          |

**Once at start**

- `setPlatform(char* name, int binaryCalls)`. `name` is what `GET /platform` answers (informational: the page doesn't switch on it). `binaryCalls` is 1 when the host passes the bodies of `POST /call` and `POST /sync` to the core, and 0 when the webview gives no request bodies. With 0, the page sends every call on the message channel and reads sync responses from `GET /sync/{id}`.
- `setOnStreamData(void (*cb)(uint8 ctx, uint32 id, int size))`, the per-chunk fallback for stream data while no frame reader is attached. On a callback, allocate `size` bytes and call `getCorePayload(ctx, 2, id, ptr, size)`, which fills `[flags u8][data]`, then call `window.fullstacked.onStreamData(id, payload)` in the page (base64 in a script). Keep this path: the page uses it until its `GET /stream` is up, and whenever it can't read a streaming response.

**Requests and calls**

| Export                                                                                    | Use                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `void* handleRequest(uint8 ctx, char* path, void* body, int len, int* status, int* size)` | Answers a request of the page with `"<mime type>\n<body>"`. It serves `/platform`, `/ctx`, `/version`, `/bridge`, `POST /call`, `POST /sync`, `/stream/detach` and the project's static files (404 when not found). |
| `void* callMessage(void* buf, int len, int* size)`                                        | A call received on the message channel. The reply is the response. Or `*size` is -1 and the reply is empty when the core put a large response (16 KiB and up) on the frame stream.                                  |
| `void* callChannel(void* buf, int len, int* size)`                                        | Like `callMessage`, but the response is never framed (for shared-memory channels)                                                                                                                                   |
| `void* callWithResponse(void* buf, int len, int* size)`                                   | A plain call and its response, for calls the host makes itself                                                                                                                                                      |
| `int call(void* buf, int len)` + `getCorePayload(ctx, 1, id, ptr, size)`                  | A call whose response the core keeps under its call id until read (the Node addon)                                                                                                                                  |

**Streams**

| Export                                            | Use                                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `int streamAttach(uint8 ctx)`                     | The caller becomes the reader of the context's frames. Returns a generation, or -1 for an unknown context. A new attach (a page reload) ends the previous reader. |
| `void* streamRead(uint8 ctx, int gen, int* size)` | Blocks until frames are queued and returns them all, as whole frames. Returns `NULL` once the reader has ended. Call it from its own thread.                      |
| `void streamDetach(uint8 ctx, int gen)`           | Ends the reader. `gen` 0 means the current one.                                                                                                                   |

## 2. The requests of the page

Intercept every request of the page's origin (a custom scheme, a `WebResourceRequested` hook, an HTTP server) and route it by path:

| Path                             | Who answers                                                                  | Thread                               |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| `GET /stream`                    | The host (see 4)                                                             | Its own reader thread                |
| `/open?ctx=`, `/exit`, `/resize` | The host (window UI)                                                         | Main thread                          |
| `GET /sync/{id}`                 | The host, when `binaryCalls` is 0: the base64 response it kept for that call |                                      |
| `POST /call`, `POST /sync`       | `handleRequest`                                                              | The serial core queue of the webview |
| Everything else                  | `handleRequest`                                                              | Any thread (a concurrent pool)       |

- The calls of one page run in order. Keep one serial queue per webview for `/call`, `/sync` and the message channel, off the UI thread. Static files can run concurrently.
- Finish each response on the thread the webview expects (usually the main thread).
- `POST /sync` is a synchronous XHR of the page. Answer it like any other request: the page waits.
- The page sends `X-Body-Size` with the body length, for hosts whose body stream reports no size (Qt).
- Without the hello frame of `/stream` (see 4), the page calls `GET /stream/detach`. Forward it to `handleRequest`, and the core goes back to the per-chunk callback.
- `/open?ctx=N` opens a window on context `N`. `/exit` closes the page's window. `/resize` sets (`?size=w:h:x:y`, `fullscreen`, `kiosk`) or returns the window size. Answer 404 for `/resize` if the host can't size windows.

## 3. The message channel (small async calls)

A request under 16 KiB costs less on a message channel of the webview than as a request. Implement one when the webview has a reply-capable message API. Otherwise set `binaryCalls` to 1 and the page posts every call (Node does this).

- The page sends the payload in base64. The host runs `callMessage` on the serial core queue and replies with the response in base64, or with an empty string when the core framed it.
- Replies that go through an evaluated script or a posted message are cheaper when batched once per main loop iteration (Windows, Android).

The page knows four shapes, detected in this order (`bridge/platform.ts`):

1. **WebKit**: a script message handler named `call`, with a reply (`WKScriptMessageHandlerWithReply`, `webkit_user_content_manager_register_script_message_handler_with_reply`). The simplest one to implement.
2. **WebView2**: `chrome.webview.postMessage(base64)`, with replies posted as `R<id>:<base64>;…`, plus the optional shared buffer of `Channel.cs`.
3. **Android**: the `fullstackedCore` JavascriptInterface (`coreCall`, `callAsync`, `setOption`) and the `fullstackedBridge` web message listener, with an `init`/`ready` handshake and batched messages.
4. **Qt**: a QWebChannel object registered as `bridge`, with `postMessage(base64, callback)`.

A new host that serves the requests of section 2 needs no JavaScript change. One that adds a message channel implements one of these four shapes.

## 4. The frame stream (GET /stream)

Stream data (readable streams, sockets, large responses) travels as binary frames on one long-lived response per page, instead of a script evaluated per chunk.

- Frame: `[streamId u32 BE][flags u8][length u32 BE][data]`. Flags: 0 data, 1 end, 2 error, 3 response of a call (the id is the call id), 4 drain, 5 connected.
- On `GET /stream`: call `streamAttach`, answer with a streaming response (`application/octet-stream`), then loop `streamRead` on a thread and write each batch to the response until it returns `NULL`. The core queues a hello frame (stream 0, empty) first. The page switches to frames once it reads it, within 3 s, otherwise it detaches and keeps evaluated chunks.
- End the reader when the page goes away (a response write fails, the connection closes, the window closes): `streamDetach(ctx, gen)`.
- Webviews hold the tail of a streaming response until more bytes arrive. The core sends keepalive frames (stream 0, empty) after data, so the host has nothing to do.
- Backpressure: the core blocks producers once 8 MiB is queued while a reader is attached.
- A webview that can't stream a response needs another channel for the frames. WebView2 gets them in shared buffers. Android fixes a response's length, so its host ends the response about every 1 GB and the page reconnects. The core keeps the frames queued meanwhile.

## 5. Checklist

1. `setPlatform`, requests routed to `handleRequest`: the page loads (`/`, `/index.html`, `/ctx`, `/bridge`).
2. `POST /sync` and `POST /call` work: the shell starts.
3. `GET /stream` with the hello frame: the shell's `bench` command reports `streamTransport: "frames"`.
4. A message channel for small calls (optional, see 3).
5. Bench with the shell: `bench -n 200 -s 1k,64k -t 4m -k 4k,256k -r 2`. Expected on desktop: small async calls in 0.06–0.2 ms, a 64 KiB echo in 0.2–0.8 ms, streams at 500–3000 MB/s with 256 KiB chunks.
