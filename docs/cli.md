# CLI

The `fullstacked` command bundles and runs a project from a terminal, with the same Go core the apps embed, loaded into Node as a native addon. Pages are served over HTTP on `localhost` and open in your browser.

```bash
npm install -g fullstacked
```

or, per project:

```bash
npm install --save-dev fullstacked
npx fullstacked
```

Prebuilt cores ship for macOS, Linux and Windows on arm64 and x64, as the optional dependencies `@fullstacked/<platform>-<arch>`.

## Usage

```text
fullstacked [options] [directory]
```

`directory` defaults to `.`. If several are given, the last one wins.

The CLI starts the core with the **current directory as its root**, which is the [sandbox](node/system.md#the-project-sandbox) of everything it runs. The project must be the current directory or below it: `fullstacked ../other-app` and absolute paths outside it fail with `entry point not found`.

| Option                             | Effect                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `-v`, `--version`                  | Print the version: `FullStacked v1.0.0-alpha (build N), branch B, hash H`                   |
| `-h`, `--help`                     | Print the help                                                                              |
| `-b`, `--build`                    | Bundle only. Exits with 1 on a build error.                                                 |
| `-e`, `--env KEY=VALUE`            | Set an environment variable, over `.env`. Repeatable.                                       |
| `-p`, `--plugin <package or file>` | Load a [build plugin](api/plugin.md#build-plugins) before bundling. Repeatable.             |
| `--port <n>`                       | First port to serve on (default 9000). Each opened project takes the next free port.        |
| `-n`, `--no-open`                  | Serve without opening the browser                                                           |
| `-f`, `--file <script> [args…]`    | Run a single script in Node instead of a project (see below)                                |
| `-s`, `--safe`                     | Ignore the project's `initialDirectory` [config](api/config.md#initialdirectory)            |
| `-l`, `--deeplink <url>`           | Deliver a `fullstacked://…` [deep link](api/plugin.md#deeplink) to the project once it runs |

Use the long form `--port`: the CLI's host code also reads `-p` as a port, so `-p 3000` would be taken as a plugin named `3000`.

## Running a project

```bash
fullstacked ./my-app
```

1. Loads `./my-app/.env`, then applies the `-e` values.
2. Registers each `-p` plugin. It is resolved like a module from the project (`@fullstacked/sass` from its `node_modules`, or a path), bundled with `bundleFile`, imported, and its default export is registered.
3. [Bundles](api/bundle.md#bundle) the project into `out/`, printing warnings and errors. It stops here on errors, or with `--build`.
4. Starts the project in a new [context](architecture.md#contexts) ([`run`](api/run.md)), with the project directory as its root.
5. Serves the context at `http://localhost:9000` (or the next free port) and opens your browser, unless `--no-open`.

The process keeps running, serving the page, until you stop it. When the page opens another project ([`run`](api/run.md) + `fullstacked.open`), that project gets its own server on the next port, and its own browser tab.

The CLI's server answers on every network interface, not only `localhost`. Run it on networks you trust.

## Running a script: --file

```bash
fullstacked --file scripts/seed.ts --count 10
```

`--file` bundles one file with [`bundleFile`](api/bundle.md#bundlefile) and imports it **into the Node process**, so the script runs on Node's engine with the runtime's modules:

- `fs`, `net`, `crypto`, … and the runtime API (`fullstacked/git`, …) are the runtime's, calling the core in-process. The script sees the same sandbox as a project: `/` is the current directory.
- The globals are Node's (`process`, `setImmediate`, `fetch`). `WebSocket` is replaced by the core's, and `window` is set to `globalThis`. A `DOMParser` is installed.
- Arguments after the file become `process.argv` (as `?argv=` on the import URL).
- `.env` is read from the current directory, `-e` applies, and both are set on `process.env`.
- The script runs until nothing keeps it alive: open sockets, file streams, timers and readline interfaces hold the process, as in Node. Then the bundled `<file>.js` is deleted.

The file can also be a package's module, resolved from the current directory.

`--file` is how build scripts, migrations and other one-off tasks run with the runtime's modules on a desktop. In the app's shell, `node <file>` is an alias for `fullstacked -f <file>`.

## From code

The CLI is the [`fullstacked`](api/fullstacked.md) module's `execute`. The app's shell runs the same command, with the same flags, inside the app.
