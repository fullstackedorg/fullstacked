# FullStacked

**Code, run and share JavaScript projects anywhere: Node's APIs on every device, iOS and Android included.**

FullStacked is a runtime for projects written in TypeScript and JavaScript. A project imports `node:fs`, `node:net` or `node:crypto`, uses npm packages, and draws its UI with the DOM, all in the same file. FullStacked bundles and runs it on macOS, Windows, Linux, iOS, iPadOS, Android and ChromeOS, or from a terminal with Node.

It works without shipping Node or a JavaScript engine. The project runs in the platform's own webview, and everything a webview can't do (files, sockets, DNS, compression, cryptography, bundling, npm installs, git) is done by a Go core that the webview reaches through [the bridge](bridge.md).

## Start here

- [Getting started](getting-started.md): install the app or the CLI and run a first project.
- [Project structure](project-structure.md): entrypoint, build output, static files, dependencies, environment, workers.
- [CLI](cli.md): the `fullstacked` command.

## How it works

- [Architecture](architecture.md): the core, the hosts, contexts, the sandbox and the platforms.
- [The bridge](bridge.md): the wire format, the transports on each platform, streams, frames and workers.

## Reference

- [Node.js compatibility](node/index.md): every built-in module, what it supports and where it runs.
    - [Pure modules](node/pure.md): `buffer`, `events`, `stream`, `util`, `assert`, …
    - [System modules](node/system.md): `fs`, `path`, `os`, `process`
    - [Networking](node/networking.md): `net`, `dgram`, `dns`, `fetch`, `WebSocket`
    - [Crypto and zlib](node/crypto-zlib.md)
    - [Workers and terminals](node/workers.md): `worker_threads`, `readline`, `tty`
    - [Unavailable modules](node/unavailable.md): `http`, `child_process`, `vm`, … and what to use instead
- [Runtime API](api/index.md): [`bundle`](api/bundle.md), [`packages`](api/packages.md), [`git`](api/git.md), [`run`](api/run.md), [`config`](api/config.md), [`tunnel`](api/tunnel.md), [`plugin`](api/plugin.md), [`auth`](api/auth.md), [`parentWindow`](api/parent-window.md), [`fullstacked`](api/fullstacked.md)

## Contributing

- [Building from source](contributing/building.md): build, test, and add a core function.
- [Porting to a new host](contributing/porting-a-host.md): the C ABI and what a host implements.

## License

FullStacked is [MIT](https://github.com/fullstackedorg/fullstacked/blob/main/LICENSE) licensed. Source: [github.com/fullstackedorg/fullstacked](https://github.com/fullstackedorg/fullstacked).
