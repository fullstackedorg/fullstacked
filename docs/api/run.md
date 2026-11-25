# run

```ts
import run from "fullstacked/run";
```

Starts another project in a new **[context](../architecture.md#contexts)**: its own root directory, environment, working directory and streams. The caller then opens it in a window. This is how the FullStacked app's shell launches projects, and how the CLI opens a project after bundling it.

```ts
run(directory?: string): Promise<number>
run(options?: { directory?: string; env?: Record<string, string>; safe?: boolean; mode?: "bundle" | "transform" }): Promise<number>
```

- `directory`: the project, relative to the caller's project (default `"."`). The new context's root is `<caller root>/<directory>` and its build directory is `<root>/out`. It must be the caller's root or a directory under it: `run` resolves `..` at the root, and the core refuses any directory outside it ("outside the context's root").
- `env`: the new project's `process.env`.
- `safe`: ignore the project's `initialDirectory` [config](config.md#initialdirectory).
- `mode`: how the page is served, see [mode](#mode). `"bundle"` when left out.

It resolves with the new context id. `run` **doesn't bundle** and **doesn't open a window**. Do both yourself:

```ts
import bundle from "fullstacked/bundle";
import run from "fullstacked/run";

const result = await bundle.bundle("/projects/todo");
if (result.Errors.length === 0) {
    const ctx = await run({
        directory: "/projects/todo",
        env: { API_URL: "https://…" }
    });
    globalThis.fullstacked.open?.(ctx); // GET /open?ctx=<id>: the host opens a window
}
```

What `open` does depends on the host:

- **The native apps** open a new window or view with its own webview.
- **The CLI** serves the context on the next free port from 9000 and opens the system browser. With `--no-open` it only serves.

The window loads the new context's `index.html`, which is `out/index.html` after a bundle.

A context lives until its window closes or it calls `process.exit()`. When it ends, the core closes all its streams (sockets, file reads, fetches).

## mode

_Beta._ `"transform"` serves the project from its sources, in [transform mode](../architecture.md#transform-mode): no `out/`, each module transformed when the page asks for it, the npm dependencies pre-bundled once and cached. Call [`prepare`](bundle.md#prepare) first, the way bundle mode calls `bundle`: its errors are the ones to show before opening a window, and it does the work ahead of the page. A context run in transform mode without `prepare` prepares itself when its page is first asked for, without build plugins.

```ts
import { prepare } from "fullstacked/bundle";
import run from "fullstacked/run";

const result = await prepare("/projects/todo");
if (result.Errors.length === 0) {
    const ctx = await run({ directory: "/projects/todo", mode: "transform" });
    globalThis.fullstacked.open?.(ctx);
}
```

A project without sources (shipped pre-built in `out/`) runs in bundle mode either way.
