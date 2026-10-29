> [!IMPORTANT]
> Development is now focused on FullStacked v1: Node.js API compatibility. [Learn more](https://fullstacked.org/v1)

---

<img height=100 width=100 src="https://files.fullstacked.org/app-icon.svg" />

# FullStacked

**Code, Run, Share. Anywhere.**

Create, run and share projects built with web technologies in a fully cross-platform, local-first environment.

[Documentation](https://docs.fullstacked.org) | [Demo](https://demo.fullstacked.org) | [Roadmap](https://fullstacked.notion.site/FullStacked-Editor-Roadmap-ebfcb685b77446c7a7898c05b219215e) | [Figma](https://www.figma.com/design/xb3JBRCvEWpbwGda03T5QQ/Mockups)

![FullStacked](https://files.fullstacked.org/fullstacked.png)

## Installation

### The latest stable release is available on all major app marketplaces.

- [Apple App Store](https://apps.apple.com/ca/app/fullstacked/id6477835950) (MacOS, iOS, iPadOS)
- [Google Play](https://play.google.com/store/apps/details?id=org.fullstacked.editor) (Android, Chromebook)
- [Microsoft Store](https://apps.microsoft.com/detail/9p987qm508vc?hl=en-us) (Windows 10/11)

You can always find those links and access to the beta apps on FullStacked [download page](https://fullstacked.org/download).

## Node.js built-ins

Projects import Node's built-in modules as they would in Node (`node:` prefix or not). The runtime serves them from `core/internal/bundle/lib`, TypeScript written for the webview, with no npm shim: what needs the system or heavy computation calls the Go core.

| Module                                                                                                                                                                                                                           | Runs in                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assert`, `buffer`, `console`, `constants`, `diagnostics_channel`, `events`, `perf_hooks`, `querystring`, `stream` (+ `/promises`, `/web`, `/consumers`), `string_decoder`, `timers` (+ `/promises`), `url`, `util` (+ `/types`) | the page, in TypeScript                                                                                                                                                          |
| `fs` (+ `/promises`), `net`, `dgram`, `dns` (+ `/promises`), `os`, `path`, `process`                                                                                                                                             | the core: files, sockets and the system                                                                                                                                          |
| `crypto`                                                                                                                                                                                                                         | MD5, SHA-1, SHA-2, HMAC, AES-CTR, ChaCha20 and random bytes in TypeScript; other ciphers (GCM, CBC, ChaCha20-Poly1305, 3DES), keys, signatures, DH/ECDH and the KDFs in the core |
| `zlib`                                                                                                                                                                                                                           | the core (deflate, gzip, brotli; the callback forms and streams off the page's thread); `crc32` in TypeScript                                                                    |
| `worker_threads`, `readline` (+ `/promises`), `tty`                                                                                                                                                                              | the page (`worker_threads` over the webview's web workers)                                                                                                                       |
| `http`, `https`, `http2`, `tls`                                                                                                                                                                                                  | not available (use `fetch`)                                                                                                                                                      |
| `child_process`, `async_hooks`, `module`, `vm`, `v8`, `sqlite`                                                                                                                                                                   | not available                                                                                                                                                                    |

`fetch` and `WebSocket` go through the core as well, and `DOMParser` is provided in workers, where the webview has none. How each module was rewritten and measured is in [`improvements/shim/plan.md`](improvements/shim/plan.md).

## Build from source

### Requirements

- [Go](https://go.dev) `>=1.26`
- [NodeJS](https://nodejs.org) `>=20`

#### Windows Requirements

- [llvm-mingw](https://github.com/mstorsjo/llvm-mingw) `=20250613`

### Steps

Clone and enter the directory.

```
git clone https://github.com/fullstackedorg/fullstacked.git
cd fullstacked
```

Checkout the submodules.

```
git submodule update --init
```

Install the dependencies and start.

```
npm install
npm start
```

## License

FullStacked is licensed under [MIT](https://github.com/fullstackedorg/fullstacked/blob/main/LICENSE), but the Editor is under [GPL-3](https://github.com/fullstackedorg/editor/blob/main/LICENSE). [Read more](https://docs.fullstacked.org/license)
