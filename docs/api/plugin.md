# plugin

```ts
import plugin from "fullstacked/plugin";
```

Plugins let the core call back into JavaScript. A plugin is a callback registered under a type, and the core invokes it when it needs something only JavaScript can provide: a build step, a credential, the handling of a deep link.

```ts
register(type: "build" | "git-auth" | "deeplink", plugin): Promise<{ unregister(): Promise<void> }>
load(type: "build" | "git-auth" | "deeplink", file: string): Promise<{ worker: boolean; unregister(): Promise<void> }>
deeplink(url: string, ctx?: number): Promise<number>
```

Plugins belong to the context that registered them. `register` registers the plugin in the runtime that calls it: the page, or a [worker](../node/workers.md) of the page, which shares its context.

## Where a plugin runs

`load(type, file)` bundles the plugin at `file` (a path) and registers its default export, in a worker or on the page:

| `data.worker` | Runs                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| not set       | in a worker for `build` plugins, on the page for `git-auth` and `deeplink` |
| `true`        | in a worker                                                                |
| `false`       | on the page                                                                |

A build plugin's work (compiling CSS, scanning sources) then never stalls the page: the page keeps drawing and answering input while the bundle waits for the plugin. A plugin that needs the page (its DOM, or UI it shows, like a git-auth prompt) sets `worker: false`. Workers have `fs`, `path`, `process` and the other Node modules, WebAssembly, and a [`DOMParser`](../node/index.md#globals), not the page's DOM.

```ts
export default {
    data: { name: "txt", filter: "\\.txt$", worker: false },
    async callback(params) {
        /* … */
    }
};
```

How `load` does it:

- It writes a small entry next to the plugin (`.<file>.<time>.plugin-worker.ts`) that imports the plugin, bundles it with [`bundleFile`](bundle.md#bundlefile), and starts it as a worker. The worker registers the plugin, or tells the page to load it when it asks for the page. The entry and its bundle are removed once the worker loaded them.
- Without workers (Node, or `load` called from a worker), and when the worker fails to start or answer within 30 s, the plugin is loaded on the page, with a warning in the console for a failure.
- `unregister()` terminates the worker. A worker that dies (an uncaught error) is terminated too: a build waiting for its plugin fails with `plugin stream closed before the plugin answered` instead of hanging.
- A bundle error throws a `PluginBundleError`, whose `errors` are esbuild's messages.

The CLI's `-p` and the shell's `bundle --plugin` load plugins with `load`.

## Build plugins

A build plugin takes over imports that match a filter during [`bundle()`](bundle.md#bundle) and produces extra output files. This is how CSS preprocessors and Tailwind are supported.

```ts
type BuildPlugin = {
    data: {
        name?: string;
        filter: string; // a Go regular expression matched against import paths
        ext?: string[]; // only imports from files ending in these extensions
    };
    callback(params: {
        sources: string[]; // every source file of the bundle, outside node_modules
        resolved: { importer: string; path: string; resolvedDir: string }[]; // the imports that matched
    }): Promise<{ outputName: string; contents: string | Uint8Array }[]>;
};
```

How it runs:

1. Each matching import is recorded and replaced by an empty module, so esbuild doesn't try to load it.
2. After esbuild finishes, the callback is called once, with every match and every source file. It isn't called if nothing matched.
3. Each returned file is written to `out/<outputName>`. A `.css` or `.js` output is also linked from `out/index.html`.

A plugin that turns `.txt` imports into one stylesheet of comments, as a minimal example:

```ts
import plugin from "fullstacked/plugin";
import fs from "node:fs";
import path from "node:path";

export default {
    data: { name: "txt", filter: "\\.txt$" },
    async callback({ resolved }) {
        const css = resolved
            .map(
                (r) =>
                    `/* ${fs.readFileSync(path.join(r.resolvedDir, r.path), "utf8")} */`
            )
            .join("\n");
        return [{ outputName: "txt.css", contents: css }];
    }
};
```

Register it before bundling, in the same context:

```ts
import txt from "./txt-plugin.ts";
const { unregister } = await plugin.register("build", txt);
await bundle.bundle("/app");
await unregister();
```

Or load it from its file, in a worker (see [Where a plugin runs](#where-a-plugin-runs)):

```ts
const txt = await plugin.load("build", "./txt-plugin.ts");
await bundle.bundle("/app");
await txt.unregister();
```

Or let the CLI load it: `fullstacked -p ./txt-plugin.ts ./app` does the same.

### Official build plugins

| Package                    | Filter                         | Use                                                                                                                                                                           |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fullstacked/sass`        | `\.(sass\|scss)$`              | `import "./style.scss"` → `out/style.scss.css`                                                                                                                                |
| `@fullstacked/tailwindcss` | `tailwindcss`, in `.css` files | `@import "tailwindcss";` in a CSS file imported from JavaScript → `out/<file>.css.tailwind.css`, with the classes found in `sources` (oxide and lightningcss, as WebAssembly) |

```bash
npm install --save-dev @fullstacked/tailwindcss
fullstacked -p @fullstacked/tailwindcss .
```

In the app's shell, use `bundle --plugin @fullstacked/tailwindcss`. No config file enables a plugin. It's passed on each build, which is a natural fit for `package.json` scripts:

```json
{ "scripts": { "start": "fullstacked -p @fullstacked/tailwindcss" } }
```

## git-auth

```ts
type GitAuthPlugin = {
    callback(host: string): Partial<{ username: string; password: string; email: string }> | Promise<…>;
};
```

Called when a git remote on `host` asks for authentication. One per context. See [git → Authentication](git.md#authentication).

## deeplink

```ts
type DeepLinkPlugin = {
    callback(url: string): void | Promise<void>;
};
```

Called with each `fullstacked://…` URL the app is opened with. Platforms receive deep links from the OS (custom URL scheme on Apple and Android, protocol activation on Windows, a command-line argument on Linux) and pass them to the running project. The CLI takes one with `--deeplink`.

Links that arrive before any deeplink plugin is ready are **queued** in the core (up to 8 per context, for 60 s) and delivered in order once a plugin registers, so a project can register its handler at startup and still get the link it was opened with.

`deeplink(url, ctx?)` triggers one programmatically, in the given context (default: this one). It resolves with the number of plugins called (0 when the link was queued).

The FullStacked app's shell handles `fullstacked:///command/<url-encoded command>`. It puts the command at the prompt, and runs it directly only when it is a single `exec` signed by FullStacked Cloud.

## How plugins are called

The first `register` of a runtime (the page, or a worker) opens its plugin stream with the core (`Plugin.StartPluginStream`), shared by the bundles of that runtime. Then:

- `register` sends `Register(type, name, data, streamId)`, stores the callback under the returned id, and sends `Ready(id)`. The plugin belongs to that stream: the core sends its calls there, and drops it when the stream closes, failing the calls still waiting for it.
- A worker opens its stream with `StartPluginStream(true)`, which keeps the plugins of the page and of other workers. The page's stream replaces every plugin of the context: a reloaded page never closes the streams of the previous one.
- The core sends `plugin-call` events (`pluginId, requestId, ...args`) on the stream.
- JavaScript answers with `plugin-response` (`pluginId, requestId, error | null, ...result`).

Build outputs are flattened into `[name, bytes, name, bytes, …]`.
