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

```bash
git -C shell submodule update --init
```

The submodules are `shell` (the app's terminal UI), the `plugins/tailwindcss` and `plugins/sass` build plugins, and `plugins/onboarding` (the app's first-launch screens, a build plugin of the shell). The second command checks out the shell's own submodule, `shell/expected-keyboard`, which the shell needs to build. Don't use `--recursive`: it would also check out `plugins/onboarding/vendor/demo`, which only pinning the onboarding's demo needs (see `plugins/onboarding/README.md`).

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
4. Builds each plugin and copies it into `node_modules/<package>`. A private plugin (`"private": true`, like `plugins/onboarding`) is skipped: builds pass it by path with `-p`, and the CLI bundles it from its sources.

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

The apps embed the shell's build output, `shell/out`. The shell is a FullStacked project, built with the CLI. To work on it, run it like any project:

```bash
npm start -- fullstacked shell
```

It opens the bare terminal. Run from the repository, the CLI needs the literal `fullstacked` token: `execute` drops everything before it, as it does for the installed `fullstacked` binary.

### The shell in the apps

The apps ship the shell built by `build-shell.ts`:

```bash
npm run build:shell:release
```

Every app build runs it first, so building an app is enough:

| Platform | Where                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| Apple    | The _Build the shell_ phase of both targets (`platform/apple/build-shell.sh`)              |
| Android  | The `buildShell` task, before `zipAppOut` (`platform/android/studio/app/build.gradle.kts`) |
| Windows  | The `BuildShell` target, before `BeforeBuild` (`platform/windows/FullStacked.csproj`)      |
| Linux    | `platform/linux/prebuild.sh`, run by `build-gtk.sh`, CMake and `publish.js`                |

The script runs `npm start -- fullstacked --build -p <plugin>… shell` (it builds the core and the Node addon first, like `npm start`), then copies extra files into `shell/out`. By default its only plugin is `plugins/onboarding`: the app opens on the onboarding at first launch, then on the terminal.

#### Startup plugins

The shell imports `./auto` (`shell/auto.ts`), a hook for build plugins. Without a plugin, `auto.ts` sets `globalThis.fullstackedShell.bare` and the terminal opens right away. A plugin whose filter matches `./auto` replaces it with an empty module and can add files to `shell/out`, such as a startup script linked from `index.html`. The shell then hands the start over:

1. The startup script sets `globalThis.fullstackedShell.held = true` as soon as it runs.
2. The shell publishes its hooks on `globalThis.fullstackedShell` (below) and fires a `fullstackedshell` event on `globalThis`.
3. The script calls `openTerminal()` when it's done.

If nothing holds the terminal within 3 seconds (the script failed to load), the terminal opens anyway.

The hooks a startup script can use, all on `globalThis.fullstackedShell`:

| Hook                       | Does                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openTerminal()`           | Opens the terminal the first time, shows it again after `hideTerminal()` (fitted to the page, focused). Resolves with the same `{ terminal, shell, fitAddon, keyboard, element }` every time.                                                                                                |
| `hideTerminal()`           | Hides the terminal. It keeps running: history, working directory, a command in progress.                                                                                                                                                                                                     |
| `registerCommand(command)` | Adds a command shaped like the built-in ones (`{ name, description, execute(args, shell, onCancel, env) }`, `shell/cli/types.ts`): `help` lists it under _More commands_, Tab completes it. Works before the terminal opens. Built-in names are refused. Returns a function that removes it. |
| `pauseDeeplinks()`         | Unregisters the shell's deeplink plugin, for example while the page shows a view of its own that handles `fullstacked:///command/...` links. The core hands links to the page's other deeplink plugins, or keeps them for the next one to register.                                          |
| `resumeDeeplinks()`        | Registers it again. The shell registers it when its terminal opens; paused before that, it waits for `resumeDeeplinks()`.                                                                                                                                                                    |

The shell fires `fullstackedshellshow` and `fullstackedshellhide` on `globalThis` whenever the terminal is shown or hidden. A deeplink command that arrives while the terminal is hidden shows it, so a page with views of its own listens for `fullstackedshellshow` to step aside.

Only one plugin can replace `./auto` in a build. To keep the onboarding with a startup of your own, wrap it: `plugins/onboarding/index.ts` exports `shellStartupPlugin(entry, name)`, which bundles `entry` as the startup script (`<name>.js` and `<name>.mjs` in `shell/out`). The entry's default export receives `globalThis.fullstackedShell`:

```ts
// my-plugin/index.ts
import { shellStartupPlugin } from "@fullstacked/onboarding";

export default shellStartupPlugin(
    new URL("./startup.ts", import.meta.url),
    "startup"
);
```

```ts
// my-plugin/startup.ts
import {
    shouldRunOnboarding,
    startOnboarding
} from "@fullstacked/onboarding/src/index.ts";

export default async function startup(shell: { openTerminal: () => unknown }) {
    if (!(await shouldRunOnboarding())) {
        shell.openTerminal();
        return;
    }
    const el = document.createElement("div");
    document.body.append(el);
    startOnboarding(el, {
        onDone: () => {
            el.remove();
            shell.openTerminal();
        }
    });
}
```

#### Other plugins and files

| Flag                    | Environment               | Effect                                                                                                     |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `-p`, `--plugin <path>` | `SHELL_PLUGINS=<a>,<b>`   | The build plugins, a path or a package name. Replaces the default, `plugins/onboarding`. Empty: no plugin. |
| `-f`, `--files <dir>`   | `SHELL_FILES=<dir>,<dir>` | Folders whose contents are copied into `shell/out` after the build                                         |

Relative paths start from the repository. Flags win over the environment. The app builds pass the environment through (Xcode takes the variables as build settings), so they need no change:

```bash
SHELL_PLUGINS=../my-plugin SHELL_FILES=../my-files npm run build:shell:release
```

```bash
xcodebuild -project platform/apple/FullStacked.xcodeproj -scheme FullStacked-MacOS SHELL_PLUGINS=../my-plugin
```

The CLI reads files only inside its root, the repository. A plugin folder outside of it is copied to `.cache/shell-plugins/<name>` for the build, so its imports resolve from there, then from the repository's `node_modules`, where `@fullstacked/onboarding` is the `plugins/onboarding` workspace.

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
