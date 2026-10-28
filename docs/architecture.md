# Architecture

FullStacked runs JavaScript projects with Node's APIs on any device, including iOS and Android, where neither Node nor a JavaScript engine of your own may run. It has three parts:

```text
 project code (TypeScript, JSX, npm packages)
        │  bundled by esbuild in the core
        ▼
┌──────────────────────────────┐
│ webview: the system's engine │  WKWebView, Android WebView, WebView2, WebKitGTK, QtWebEngine
│  + runtime lib (TypeScript)  │  Node's modules, the runtime API, the bridge
└──────────────┬───────────────┘
               │  the bridge: HTTP requests + message channels + a frame stream
┌──────────────▼───────────────┐
│ host (native app or Node)    │  Swift, Kotlin, C#, C++, Node addon
└──────────────┬───────────────┘
               │  C ABI
┌──────────────▼───────────────┐
│ core (Go, one library)       │  fs, net, dns, crypto, zlib, fetch, WebSocket,
│                              │  esbuild, npm installer, git, tunnels
└──────────────────────────────┘
```

- **The core** (`core/`) is a Go library with a C ABI, built as a static or shared library for each platform. It does everything that needs the system or heavy computation: files, sockets, DNS, HTTP, TLS, compression, cryptography, bundling (esbuild), package installs and git (go-git). One core serves every project open in the app.
- **The host** (`platform/`) is a thin native app: a window with a webview, which serves the page's requests to the core and relays the page's calls. It's about 220 lines of bridge per platform. See [Platforms](#platforms).
- **The runtime lib** (`core/internal/bundle/lib`) is TypeScript embedded in the core. The bundler injects it into every project: Node's built-ins, written for the webview ([Node.js compatibility](node/index.md)), the runtime API ([Runtime API](api/index.md)) and the bridge client ([The bridge](bridge.md)).

JavaScript always runs on the platform's own engine: JavaScriptCore on Apple and WebKitGTK, V8 on Android, WebView2 and QtWebEngine. FullStacked doesn't ship a JavaScript engine. That's what lets it run on iOS, and it keeps the apps small.

## Contexts

A **context** is one running project in the core. Every bridge call carries its context id (one byte), and the core resolves everything against it:

| Field                | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `Directories.Root`   | The project directory. `/` for `fs`, `path` and `process.cwd()`.             |
| `Directories.Build`  | Where the page is served from first: `<root>/out`                            |
| `Cwd`                | `process.cwd()`, relative to the root (starts at `/`)                        |
| `Env`                | `process.env`                                                                |
| Streams              | Open sockets, file streams, fetches, and the [frame queue](bridge.md#frames) |
| Crypto, zlib handles | Hash, cipher and compressor states                                           |
| Plugins              | Registered [plugins](api/plugin.md), queued deep links                       |
| Git credentials      | Cached per host                                                              |

A host creates the first context at startup (`start(root, build)`). For the apps, that context runs the shell. For the CLI, it's the CLI's own process. New contexts come from [`run`](api/run.md). A page and its workers share one context. Ids are one byte, which caps the number of contexts open at once at 256.

A context ends when its window closes, or a second after it calls `process.exit()`. Then the core closes every stream it opened (sockets, reads, fetches, WebSockets) and frees its handles.

### The sandbox

Every path a project passes to the core is resolved inside its context's root: `/` is the project directory, and a path that climbs above it is clamped to it. A project can read and write its own files and nothing else on the device through `fs`, `git`, `packages` or `bundle`. The app's shell is the context whose root is the app's projects directory, which is how it manages every project.

The sandbox applies to files. Network access (`net`, `fetch`, `dgram`) is unrestricted.

## A project's lifecycle

1. **Bundle.** [`bundle`](api/bundle.md) runs esbuild in the core on the project's entrypoint. Built-in imports resolve to the embedded lib, and npm imports to `node_modules`. The output goes to `out/`, with a generated `index.html`.
2. **Run.** [`run`](api/run.md) creates a context with the project as its root.
3. **Open.** The host opens a window on a URL of its own (`fs://localhost`, `http://localhost`, or `http://localhost:<port>` for the CLI) and binds it to the context.
4. **Load.** The page fetches `out/index.html` and the bundle. The bundle's first import (`fullstacked`) initializes the bridge: it reads its context id from `GET /ctx`, detects the host's transports, attaches the frame stream, replaces `fetch` and `WebSocket`, installs `process`, `Buffer` and `setImmediate`, and restores the window size. Then the project's code runs.
5. **Run.** Each core-backed call crosses [the bridge](bridge.md): a sync call blocks the page like Node's sync APIs do, and an async call resolves when the core answers. Data that flows over time comes back as [streams](bridge.md#streams).
6. **Exit.** Closing the window, or `process.exit()`, ends the context.

## Platforms

| Platform                | Webview             | Page origin                       | Projects directory           | Calls                              |
| ----------------------- | ------------------- | --------------------------------- | ---------------------------- | ---------------------------------- |
| macOS, iOS, iPadOS      | WKWebView (SwiftUI) | `fs://localhost` (scheme handler) | The app's Documents          | WebKit message handler + requests  |
| Android, ChromeOS       | Android WebView     | `http://localhost` (intercepted)  | `filesDir/projects`          | JavascriptInterface + web messages |
| Windows 10/11           | WebView2 (WinUI)    | `http://localhost` (intercepted)  | `%LOCALAPPDATA%\fullstacked` | Shared buffer + web messages       |
| Linux                   | WebKitGTK           | `fs://` (scheme)                  | `~/FullStacked`              | WebKit message handler + requests  |
| Linux                   | QtWebEngine         | `fs://` (scheme handler)          | `~/FullStacked`              | QWebChannel + messages             |
| Node.js ([CLI](cli.md)) | your browser        | `http://localhost:9000+`          | the current directory        | HTTP requests                      |

Every platform starts in _safe mode_ on request (Cmd+Shift+T on macOS, `--safe` on Linux and in the CLI), which ignores `initialDirectory`.

The native apps ship the shell, the project in `shell/` built to `shell/out`, as their main page. The shell is a terminal (xterm.js) with commands for git, npm, bundling and running projects, all of it written in TypeScript over the runtime API.

## Repository layout

| Path                    | Contents                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/`                 | The Go core: `main.go` (C ABI), `internal/<module>` (one package per bridge module), `internal/bundle/lib` (the runtime lib, TypeScript), `build/` (per-platform builds) |
| `core/types/`, `types/` | Shared Go types and the generator of their TypeScript mirrors (`npm run generate-types`)                                                                                 |
| `platform/`             | Hosts: `apple`, `android`, `windows`, `linux`, `node` (CLI and addon), `@fullstacked/*` (prebuilt core packages)                                                         |
| `shell/`                | The app's terminal UI, itself a FullStacked project (git submodule)                                                                                                      |
| `plugins/`              | The `@fullstacked/tailwindcss` and `@fullstacked/sass` build plugins (git submodules)                                                                                    |
| `test/`                 | Node test runner suites: unit, end-to-end in Node, and integration in a real webview (Puppeteer)                                                                         |
| `docs/`                 | This site                                                                                                                                                                |
