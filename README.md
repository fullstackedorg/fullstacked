<p align="center">
  <a href="https://fullstacked.org">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/readme/lockup-fullstacked-dark.png">
      <img alt="FullStacked" src=".github/readme/lockup-fullstacked-light.png" height="72">
    </picture>
  </a>
</p>

<h3 align="center">Build anything. Run it everywhere.</h3>

<p align="center">
  Run JavaScript and TypeScript projects with Node.js and browser APIs in the same file.<br>
  No server to start, no build to configure. Build on your computer, then pull and run the same project on your phone.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/fullstacked"><img alt="npm" src="https://img.shields.io/npm/v/fullstacked?label=npm&color=38BDF8"></a>
  <a href="https://www.npmjs.com/package/fullstacked?activeTab=versions"><img alt="npm beta" src="https://img.shields.io/npm/v/fullstacked/beta?label=npm%20beta&color=38BDF8"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-38BDF8"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-iOS%20%C2%B7%20Android%20%C2%B7%20macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-0B1328">
</p>

<p align="center">
  <a href="https://fullstacked.org">Website</a> ·
  <a href="https://docs.fullstacked.org">Docs</a> ·
  <a href="#download">Download</a>
</p>

![FullStacked on a computer: clone a project, install it and run it, right in the app](https://files.fullstacked.org/fullstacked.png)

## One file. Both worlds.

Your UI and your logic run in the same JavaScript context, bridged to a native core.

- **Node.js and the browser together.** Import React next to `node:fs`, `node:net` and `node:crypto`. Call your functions directly: no REST layer, no local server.
- **Zero-config bundling.** TypeScript and JSX are bundled by esbuild every time you run. No HTML file to write, no config to keep in sync.
- **fetch without CORS.** `fetch` and `WebSocket` run in the native core, so any URL works from your UI. No proxy, no preflight.
- **Commands you already know.** `git`, `npm`, `ssh`, `curl` and `vi` are built in. Like a terminal on Linux, the shell is where you start, not where you stop.
- **Local-first.** Projects live on the device. Nothing leaves it unless you push it.
- **Tunnels to private services.** Reach databases and internal APIs behind a firewall from any device. Drivers like `pg` work unchanged. No port forwarding, no VPN.

## Get started

From `npm install` to your phone: build locally, push to Git, run anywhere.

**1. Install.** Add FullStacked to any JavaScript or TypeScript project.

```sh
npm i fullstacked
```

Or `npm i fullstacked@beta` for the latest beta.

**2. Write `index.tsx`.** Use Node.js and browser APIs in the same file.

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";

function App() {
  const message = fs.readFileSync("message.txt", "utf8");
  return <h1>{message}</h1>;
}

const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(<App />);
```

**3. Run it.** Bundle and run with one command.

```sh
npx fullstacked
```

**4. Push.** Any Git host works. No CI, no deploy step.

```sh
git commit -am "first version"
git push
```

**5. Run it anywhere.** Open the FullStacked app on any device, pull and run.

```sh
git clone https://github.com/you/my-project
cd my-project
npm install
fullstacked
```

## Download

Install FullStacked in your projects and get the app on every device. The app opens on a shell: clone a repository and run it.

**Stable** releases are the ones to use. The first stable release of FullStacked v1 is coming soon.

| Platform | Stable |
| :--- | :--- |
| Node.js package (macOS, Windows, Linux · x64, arm64) | `npm i fullstacked` · [npm](https://www.npmjs.com/package/fullstacked) |
| iPhone, iPad and Mac | [App Store](https://apps.apple.com/app/id6477835950) |
| Windows 10 and 11 | [Microsoft Store](https://apps.microsoft.com/detail/9P1TF0N0VHNC) |
| Android and ChromeOS | [Google Play](https://play.google.com/store/apps/details?id=org.fullstacked) |
| Linux (x64, arm64 · GTK or Qt) | [All Linux builds](https://fullstacked.org/download) |

**Beta** builds ship from every change to `main`, to try what's next before it's released.

| Platform | Beta |
| :--- | :--- |
| Node.js package | `npm i fullstacked@beta` · [npm](https://www.npmjs.com/package/fullstacked?activeTab=versions) |
| iPhone, iPad and Mac | [TestFlight](https://testflight.apple.com/join/CUYvvR4b) |
| Windows 10 and 11 | [Microsoft Store (beta)](https://apps.microsoft.com/detail/9N9BCQSWWZ79) |
| Android and ChromeOS | [Join the tester program](https://play.google.com/apps/testing/org.fullstacked), then [Google Play](https://play.google.com/store/apps/details?id=org.fullstacked) |
| Linux | [All Linux builds](https://fullstacked.org/download) |

See [Releases](https://docs.fullstacked.org/contributing/releases) for how versions and channels work.

## The Node.js you know, on every device

Projects import Node's built-in modules as they would in Node (`node:` prefix or not). The runtime serves them from `core/internal/bundle/lib`, TypeScript written for the webview, with no npm shim: what needs the system or heavy computation calls the Go core. Database drivers like `pg`, `ioredis` and `mongodb` work as-is.

| Module | Runs in |
| --- | --- |
| `assert`, `buffer`, `console`, `constants`, `diagnostics_channel`, `events`, `perf_hooks`, `querystring`, `stream` (+ `/promises`, `/web`, `/consumers`), `string_decoder`, `timers` (+ `/promises`), `url`, `util` (+ `/types`) | the page, in TypeScript |
| `fs` (+ `/promises`), `net`, `dgram`, `dns` (+ `/promises`), `os`, `path`, `process` | the core: files, sockets and the system |
| `crypto` | MD5, SHA-1, SHA-2, HMAC, AES-CTR, ChaCha20 and random bytes in TypeScript; other ciphers (GCM, CBC, ChaCha20-Poly1305, 3DES), keys, signatures, DH/ECDH and the KDFs in the core |
| `zlib` | the core (deflate, gzip, brotli; the callback forms and streams off the page's thread); `crc32` in TypeScript |
| `worker_threads`, `readline` (+ `/promises`), `tty` | the page (`worker_threads` over the webview's web workers) |
| `http`, `https`, `http2`, `tls` | not available (use `fetch`) |
| `child_process`, `async_hooks`, `module`, `vm`, `v8`, `sqlite` | not available |

`fetch` and `WebSocket` go through the core as well, and `DOMParser` is provided in workers, where the webview has none. More in the [docs](https://docs.fullstacked.org).

## FullStacked Cloud

Want to jumpstart your development? [FullStacked Cloud](https://fullstacked.cloud) gives you and your AI agent every resource to build any tool you imagine: Git hosting, managed databases, private network access and an MCP server. One click connects the app.

- Postgres, Redis, MongoDB and S3 in one click
- Share a project and it's on your team's devices instantly
- Let Claude or Cursor build it for you

## Build from source

Requirements: [Go](https://go.dev) `>=1.26` and [Node.js](https://nodejs.org) `>=20`. On Windows, also [llvm-mingw](https://github.com/mstorsjo/llvm-mingw) `=20250613`.

```sh
git clone https://github.com/fullstackedorg/fullstacked.git
cd fullstacked
git submodule update --init
npm install
npm start
```

## Contributing

FullStacked is built in the open. Issues, ideas and pull requests are welcome: [open an issue](https://github.com/fullstackedorg/fullstacked/issues) or send a pull request.

Star it, fork it, build with it.

## License

[MIT](LICENSE) © FullStacked
