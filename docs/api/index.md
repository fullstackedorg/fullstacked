# Runtime API

Besides Node's built-ins, the runtime provides its own modules for what a development environment needs on any device: bundling, installing packages, git, opening projects, tunnels and plugins. Like the Node modules, they are embedded in the core and resolved by the bundler, so nothing is installed from npm.

| Module                             | Import                     | What it does                                                                                                         |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`bundle`](bundle.md)              | `fullstacked/bundle`       | Bundle a project or a file with esbuild, inside the core                                                             |
| [`packages`](packages.md)          | `fullstacked/packages`     | Install, uninstall and audit npm packages, and resolve modules                                                       |
| [`git`](git.md)                    | `fullstacked/git`          | Clone, commit, pull, push, branch and more, with go-git                                                              |
| [`run`](run.md)                    | `fullstacked/run`          | Start another project in a new context and open it                                                                   |
| [`config`](config.md)              | `fullstacked/config`       | Per-project key/value settings                                                                                       |
| [`tunnel`](tunnel.md)              | `fullstacked/tunnel`       | Route connections through a tunnel hub                                                                               |
| [`plugin`](plugin.md)              | `fullstacked/plugin`       | Build plugins, git credentials, deep links                                                                           |
| [`auth`](auth.md)                  | `fullstacked/auth`         | Popup sign-in flow                                                                                                   |
| [`parentWindow`](parent-window.md) | `fullstacked/parentWindow` | Remember and restore the window size                                                                                 |
| [`fullstacked`](fullstacked.md)    | `fullstacked`              | The CLI as a function: `execute("fullstacked -b ./app")`                                                             |
| `fetch`                            | `fullstacked/fetch`        | The core's fetch, also installed as `globalThis.fetch` (see [Networking](../node/networking.md#fetch-and-websocket)) |
| `websocket`                        | `fullstacked/websocket`    | The core's WebSocket, also `globalThis.WebSocket`                                                                    |

## Importing

Each module can be imported three ways, all equivalent:

```ts
import git from "fullstacked/git"; // recommended
import git from "git";
import git from "node:git";
```

The bundler strips `node:` and `fullstacked/`, then looks the name up in its module table **before** `node_modules`. The `fullstacked/` form is recommended because it says where the module comes from, and it's the form the TypeScript declarations use. It also shows that an npm package with the same name (`config`, `git`, …) can't be imported by its bare name in a FullStacked project. See [How a built-in is resolved](../node/index.md#how-a-built-in-is-resolved).

## Types

The `fullstacked` npm package ships the declarations. Add it as a dev dependency for editor support:

```bash
npm install --save-dev fullstacked
```

It declares `fullstacked`, `fullstacked/auth`, `fullstacked/bundle`, `fullstacked/config`, `fullstacked/git`, `fullstacked/packages`, `fullstacked/parentWindow`, `fullstacked/plugin`, `fullstacked/run`, `fullstacked/test` and `fullstacked/tunnel`. `fullstacked/fetch` and `fullstacked/websocket` resolve at bundle time but have no declared types (they have the same shapes as the global `fetch` and `WebSocket`).

## Streams and event emitters

Long operations return a stream rather than a single value. For example, `git.clone` returns the clone's progress text, and `packages.install` returns progress events. They come in two shapes:

- **`Duplex`**: a `ReadableStream<Uint8Array>` with `on("data" | "close" | "error")`, async iteration, `promise()` (all bytes), `write()` and `end()`. See [Streams](../bridge.md#streams).
- **`EventEmitter`**: `on(event, fn)`, `off(event, fn)`, built on a Duplex that carries [events](../bridge.md#events).

**Streams start when you consume them.** The core doesn't run the operation until JavaScript opens the stream, which happens on the first listener, iteration or `promise()`. Awaiting the call alone only gets you the stream:

```ts
const stream = await git.clone("https://github.com/user/repo.git", "/repo");
// nothing has happened yet
for await (const chunk of stream) {
    console.log(new TextDecoder().decode(chunk)); // progress lines
}
// cloned
```

## Errors

A failure in the core rejects with `Error("error from bridge: [<message>]")`, or for a stream, fires `error` and rejects the iteration or `promise()`. `bundle` is the exception: it resolves with build errors in its result (see [`bundle`](bundle.md#result)).
