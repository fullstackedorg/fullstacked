# Building from source

## Requirements

- [Go](https://go.dev) 1.26 or later
- [Node.js](https://nodejs.org) 20 or later
- Windows: [llvm-mingw](https://github.com/mstorsjo/llvm-mingw) `20250613`

## Clone

```bash
git clone https://github.com/fullstackedorg/fullstacked.git
```

```bash
cd fullstacked
```

```bash
git submodule update --init
```

The submodules are `shell` (the app's terminal UI) and the `plugins/tailwindcss` and `plugins/sass` build plugins.

## Build and run

```bash
npm install
```

```bash
npm start
```

`npm start` runs `build.ts`, builds the Node addon (`platform/node/build.ts`), and starts the CLI from the repository (`platform/node/index.ts`). `build.ts`:

1. Generates the TypeScript mirrors of the Go types (`types/generate.go` → `core/internal/bundle/lib/@types/*.ts`). Run it on its own with `npm run generate-types` after changing a module's function ids or a shared struct.
2. Writes `core/internal/bundle/lib/process/version.json` (version, build number, branch, commit).
3. Builds the core as a shared library for the current OS and architecture (`make <os>-<arch>-shared` in `core/build`, or `windows.bat` on Windows).
4. Builds each plugin and copies it into `node_modules/<package>`.

## The core for each platform

`core/build/Makefile` has a target per platform:

| Target                                                                     | Output                               |
| -------------------------------------------------------------------------- | ------------------------------------ |
| `darwin-arm64-shared`, `darwin-x64-shared`                                 | Shared library for the CLI on macOS  |
| `darwin-static` (`darwin-arm64-static` + `darwin-x64-static`), `ios-arm64` | Static libraries for the Apple app   |
| `android` (`android-arm`, `android-arm64`, `android-x64`)                  | Shared libraries for the Android app |
| `linux-arm64-shared`, `linux-x64-shared`, `linux-*-static`                 | The CLI and the Linux app            |
| `windows.bat <arch>`                                                       | The DLL for Windows (x64, arm64)     |

Then open the host's project:

| Platform | Project                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| Apple    | `platform/apple/FullStacked.xcodeproj` (it bundles `shell/out` as the app's page) |
| Android  | `platform/android/studio` (Android Studio / Gradle)                               |
| Windows  | `platform/windows/FullStacked.sln` (WinUI, MSIX)                                  |
| Linux    | `platform/linux` (CMake: `build-gtk.sh`, or the Qt target)                        |
| Node     | `platform/node` (`npm run build`, published as the `fullstacked` npm package)     |

The apps embed the shell's build output, `shell/out` (Xcode, Gradle and the Linux packaging copy it). The shell is a FullStacked project, so build it with the CLI before building an app:

```bash
node platform/node/index.ts fullstacked --build shell
```

Run from the repository, the CLI needs the literal `fullstacked` token: `execute` drops everything before it, as it does for the installed `fullstacked` binary.

## Tests

```bash
npm test
```

`pretest` builds the core and the Node addon. `test/index.ts` then imports every suite in Node's test runner (`node --test`), with coverage. To run a subset, pass suite directories:

```bash
npm test -- test/fs test/net
```

A suite usually has three layers:

| File             | Runs                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`       | Unit tests of the lib in Node, through the addon                                                                               |
| `e2e.ts`         | The lib in Node against real servers (spawned processes, Docker containers)                                                    |
| `integration.ts` | A sample project bundled and loaded in **headless Chromium** (Puppeteer), served by the Node host, to exercise the real bridge |

Some suites need Docker (for example the PostgreSQL tunnel and OpenSSH tests) and are skipped without it. `test/shim` compares each rewritten Node module with Node's own (see [Node.js compatibility](../node/index.md#running-the-conformance-suite)). `SSH_MATRIX=all` turns on the full ssh2 algorithm matrix in `test/net`.

`npm run typecheck` runs `tsc --noEmit` over the repository, and `npm run fmt` formats it with Prettier and clang-format.

## Adding a function to a core module

1. **Go.** Add the function id to the module's `const` block in `core/internal/<module>`, and a `case` to its `Switch(ctx, header, data, response)`. Read the arguments from `data[i].Data` (a `string`, `float64`, `bool`, `[]byte`, or a `DeserializedRawObject` holding JSON). Set `response.Type` and `response.Data`, or return an `error`.
2. **Types.** Run `npm run generate-types` to update `lib/@types/<module>.ts`.
3. **TypeScript.** Call it from the lib with `globalThis.fullstacked.bridge({ mod, fn, data }, sync?)`.
4. **Streams.** For a long-running or streaming result, set `response.Type = CoreResponseStream` with a `ResponseStream` whose `Open` starts the work in a goroutine and reports through `store.StreamChunk`, `StreamEvent` or `StreamError`. See [Streams](../bridge.md#streams).

A Go panic in a module isn't turned into an error response (only crypto and zlib recover), so validate the argument types you read.
