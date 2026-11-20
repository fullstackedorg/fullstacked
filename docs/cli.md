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

| Option                             | Effect                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-v`, `--version`                  | Print the version: `FullStacked v1.0.0 (build N), branch B, hash H`                                                                                           |
| `-h`, `--help`                     | Print the help                                                                                                                                                |
| `-b`, `--build`                    | Bundle only, for production: `NODE_ENV` is `"production"` and the output is minified ([details](api/bundle.md#build-options)). Exits with 1 on a build error. |
| `--transform`                      | Run without bundling first, in [transform mode](#transform-mode-beta) (beta). Ignored with `--build`.                                                          |
| `-e`, `--env KEY=VALUE`            | Set an environment variable, over `.env`. Repeatable.                                                                                                         |
| `-p`, `--plugin <package or file>` | Load a [build plugin](api/plugin.md#build-plugins) before bundling. Repeatable.                                                                               |
| `--port <n>`                       | First port to serve on (default 9000). Each opened project takes the next free port.                                                                          |
| `-n`, `--no-open`                  | Serve without opening the browser                                                                                                                             |
| `-f`, `--file <script> [args…]`    | Run a single script in Node instead of a project (see below)                                                                                                  |
| `-s`, `--safe`                     | Ignore the project's `initialDirectory` [config](api/config.md#initialdirectory)                                                                              |
| `-l`, `--deeplink <url>`           | Deliver a `fullstacked://…` [deep link](api/plugin.md#deeplink) to the project once it runs                                                                   |

`--port` has no short form: `-p` is `--plugin`.

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

## Transform mode (beta)

```bash
fullstacked --transform ./my-app
```

Starts the project without bundling it first. Nothing is written to `out/`:

1. Loads `.env`, applies `-e` and registers the `-p` plugins, as above.
2. [Prepares](api/bundle.md#prepare) the project: scans it from its entry point (its errors stop the CLI before the browser opens, with the same messages and exit code 1 as a bundle), pre-bundles its npm dependencies once (cached in `node_modules/.fullstacked/deps`, rebuilt when the lockfile changes), runs the build plugins and transforms its modules.
3. Runs it with [`run({ mode: "transform" })`](api/run.md#mode): the page loads each module of the project on its own, transformed.

A warm start (dependencies cached) does no dependency build, so projects with many packages start faster; the very first run builds the dependencies, which takes about as long as a bundle. Reloading the page picks up edited files: changed modules are transformed again, a package imported for the first time rebuilds the dependencies, and a build plugin runs again. A module that fails to transform after the start shows its error over the page and in the console instead of a blank page.

Transform mode is in beta: bundle mode stays the default, and `--build` always bundles. See [Architecture: transform mode](architecture.md#transform-mode) for how it works and how it differs.

## Running a script: --file

```bash
fullstacked --file scripts/seed.ts --count 10
```

`--file` bundles one file with [`bundleFile`](api/bundle.md#bundlefile) and imports it **into the Node process**, so the script runs on Node's engine with the runtime's modules:

- `fs`, `net`, `crypto`, … and the runtime API (`fullstacked/git`, …) are the runtime's, calling the core in-process. The script sees the same sandbox as a project: `/` is the current directory.
- The globals are Node's (`process`, `setImmediate`, `fetch`). `WebSocket` is replaced by the core's, and `window` is set to `globalThis`. A `DOMParser` is installed.
- Arguments after the file become `process.argv` (as `?argv=` on the import URL), verbatim: the CLI's own options end at the file, so `fullstacked -f script.ts -s token -e x` hands `-s token -e x` to the script. Put the CLI's options before `-f`.
- `.env` is read from the current directory, `-e` (before the file) applies, and both are set on `process.env`.
- The script runs until nothing keeps it alive: open sockets, file streams, timers and readline interfaces hold the process, as in Node.
- Nothing is written next to the script: the bundle stays in the core's memory and is imported once from `<file>.fullstacked-<id>.js`, a path of its own next to the file (so `import.meta.url` and `import.meta.dirname` point next to the script). Two runs of the same script don't share anything, and a script runs from a read-only folder. On Node before 22.15 (no `module.registerHooks`), the bundle is written as `<file>.js` and deleted afterward, as before.

The file can also be a package's module, resolved from the current directory.

`--file` is how build scripts, migrations and other one-off tasks run with the runtime's modules on a desktop. In the app's shell, `node <file>` is an alias for `fullstacked -f <file>`.

## From code

The CLI is the [`fullstacked`](api/fullstacked.md) module's `execute`. The app's shell runs the same command, with the same flags, inside the app.
