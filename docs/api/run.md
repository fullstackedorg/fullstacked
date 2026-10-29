# run

```ts
import run from "fullstacked/run";
```

Starts another project in a new **[context](../architecture.md#contexts)**: its own root directory, environment, working directory and streams. The caller then opens it in a window. This is how the FullStacked app's shell launches projects, and how the CLI opens a project after bundling it.

```ts
run(directory?: string): Promise<number>
run(options?: { directory?: string; env?: Record<string, string>; safe?: boolean }): Promise<number>
```

- `directory`: the project, relative to the caller's project (default `"."`). The new context's root is `<caller root>/<directory>` and its build directory is `<root>/out`.
- `env`: the new project's `process.env`.
- `safe`: ignore the project's `initialDirectory` [config](config.md#initialdirectory).

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
