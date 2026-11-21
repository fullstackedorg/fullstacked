# Cold-start bench

How long a project takes from the command that runs it to its first render, in bundle mode (`bundle`, then `run`) and in [transform mode](../architecture.md#transform-mode) (`prepare`, then `run({ mode: "transform" })`). Each fixture runs **cold** (no `out/`, no cached dependencies) once, then **warm** (the dependencies cached, the lib in the user's cache folder) three times; the tables give the medians.

## Fixtures

Defined once in `shell/cli/bench/cold-start-fixtures.ts`, written by the bench itself, then their packages installed:

| Fixture   | What                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `small`   | One `index.tsx` with React                                                                                                                                                                                               |
| `demo`    | [fullstackedorg/demo](https://github.com/fullstackedorg/demo) at the onboarding's pin (React, three.js, the Tailwind CSS plugin)                                                                                         |
| `heavy`   | React, MUI, Recharts, date-fns and lucide-react: several hundred modules from `node_modules`                                                                                                                             |
| `modules` | Transform mode only: the host's module system (static imports, `import()`, a `.tsx` module, a module worker importing a module of the page, 300 modules at once, an import that fails). Its run fails when a check does. |

Each app writes the time of its first render (two animation frames after its code ran) to `/.cold-start.json`.

## Running it

**Node CLI**, from the repository (a headless Chrome waits for the app's element):

```bash
node test/bench/cold-start/node.ts -o results.json
```

`--fixtures small,demo`, `--modes transform`, `-r <warm runs>`. It also times `fullstacked -f` with a script that imports React and lodash.

**In the apps**, the shell's `bench cold-start` (`--help` for its options) runs the same fixtures, opening each run in a window that exits after its first render. `--upload <url>` posts the results to a receiver:

```bash
node test/bench/cold-start/receiver.ts results 8765
```

To run it with nobody at the device, set the shell's `initScript` [config](../api/config.md) in the projects directory's `.git/config.json` before launching the app, with `"onboarding": "1"` so the terminal opens at once:

```json
{
    "onboarding": "1",
    "initScript": "bench cold-start --upload http://<receiver>:8765/result/android-s9"
}
```

| Host    | Projects directory of a test build                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Containers/<bundle id>/Data/Documents` (build with another `PRODUCT_BUNDLE_IDENTIFIER`)      |
| Android | `files/projects` of a debug build: `adb shell run-as <package> …` (build with an `applicationIdSuffix`) |
| Windows | `%LOCALAPPDATA%\Packages\<package family name>\LocalCache\Local\fullstacked` (the package's AppData)    |
| Linux   | `$HOME/FullStacked`                                                                                     |

A locked screen stops the bench: WebKit, WebKitGTK and QtWebEngine don't paint a window nobody can see, so no first render comes. On Android, a window that exited keeps its page running in the background for a while: for a fixture that keeps drawing (the demo's three.js scene), compare one warm run per app launch (`--fixtures demo --modes transform --warm -r 0`, then the same with `bundle`), not consecutive runs.

## Transform mode: results

Medians in milliseconds from the command to the first render, bundle mode (the baseline) against transform mode. Taken on 2026-11-20, branch `transform-mode`.

**Node CLI on macOS** (Apple silicon), Chrome headless, commit `b590c442`:

| Fixture | Bundle, cold | Bundle, warm | Transform, cold | Transform, warm | Warm |
| ------- | -----------: | -----------: | --------------: | --------------: | ---: |
| small   |          188 |          192 |             173 |             155 | −19% |
| demo    |          598 |          617 |             567 |             511 | −17% |
| heavy   |          536 |          380 |             386 |             236 | −38% |

`fullstacked -f` with a script that imports React and lodash: 125–160 ms from the command to its output, about 60 ms of it bundling in memory: running `-f` in transform mode would save tens of milliseconds at most, so `-f` keeps its in-memory bundle on every host.

**Windows 11 x64 app** (WebView2), commit `c165349e`:

| Fixture | Bundle, cold | Bundle, warm | Transform, cold | Transform, warm | Warm |
| ------- | -----------: | -----------: | --------------: | --------------: | ---: |
| small   |          379 |          369 |             500 |             230 | −38% |
| demo    |         1446 |         1481 |            1736 |            1483 |   0% |
| heavy   |         1056 |          946 |             836 |             346 | −63% |
| modules |              |              |             664 |             486 |      |

**Android app** (Galaxy S9+, Android System WebView), commit `c165349e`:

| Fixture | Bundle, cold | Bundle, warm | Transform, cold | Transform, warm | Warm |
| ------- | -----------: | -----------: | --------------: | --------------: | ---: |
| small   |          429 |          437 |             544 |             200 | −54% |
| heavy   |         2252 |         1250 |            1415 |             339 | −73% |
| modules |              |              |             812 |             608 |      |

The demo, one warm run per app launch (three each): bundle 3770, 3945 and 4239, transform 3908, 4146 and 4117 (medians 3945 and 4117, +4%). Transform mode's page loads as fast; its prepare takes about 150 ms more than the bundle, most of both being the Tailwind CSS plugin.

**Linux arm64 app**, WebKitGTK (GNOME on Wayland, in a VM without 3D acceleration), commit `c165349e`:

| Fixture | Bundle, cold | Bundle, warm | Transform, cold | Transform, warm | Warm |
| ------- | -----------: | -----------: | --------------: | --------------: | ---: |
| small   |          437 |          231 |             278 |             198 | −14% |
| demo    |         1564 |          503 |             530 |             512 |  +2% |
| heavy   |         1511 |          463 |             398 |             260 | −44% |
| modules |              |              |             246 |             194 |      |

**Linux arm64 app**, QtWebEngine (same machine), commit `c165349e`:

| Fixture | Bundle, cold | Bundle, warm | Transform, cold | Transform, warm | Warm |
| ------- | -----------: | -----------: | --------------: | --------------: | ---: |
| small   |          163 |          167 |             216 |             131 | −22% |
| demo    |          521 |          513 |             477 |             453 | −12% |
| heavy   |          328 |          356 |             331 |             201 | −44% |
| modules |              |              |             297 |             240 |      |

**macOS app** (Apple silicon, WKWebView), commit `c165349e`:

| Fixture | Bundle, cold | Bundle, warm | Transform, cold | Transform, warm | Warm |
| ------- | -----------: | -----------: | --------------: | --------------: | ---: |
| small   |          139 |          162 |             166 |             140 | −14% |
| demo    |          338 |          269 |             255 |             232 | −14% |
| heavy   |          346 |          334 |             335 |             204 | −39% |
| modules |              |              |             191 |             152 |      |

iOS shares the macOS app's host code and wasn't measured on its own.

The demo's build is mostly its Tailwind CSS plugin, which both modes run: with little bundling to save, transform mode is level with bundle mode there. A first run in transform mode (no cached dependencies) builds the dependencies and is slower for small projects.
