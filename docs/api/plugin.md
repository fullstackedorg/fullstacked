# plugin

```ts
import plugin from "fullstacked/plugin";
```

Plugins let the core call back into JavaScript. A plugin is a callback registered under a type, and the core invokes it when it needs something only JavaScript can provide: a build step, a credential, the handling of a deep link.

```ts
register(type: "build" | "git-auth" | "deeplink", plugin): Promise<{ unregister(): Promise<void> }>
deeplink(url: string, ctx?: number): Promise<number>
```

Plugins belong to the context that registered them.

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

Or let the CLI load it: `fullstacked -p ./txt-plugin.ts ./app`. The file is bundled with `bundleFile`, imported, and its default export is registered.

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

The first `register` opens a plugin stream between the context and the core (`Plugin.StartPluginStream`). Then:

- `register` sends `Register(type, name, data)`, stores the callback under the returned id, and sends `Ready(id)`.
- The core sends `plugin-call` events (`pluginId, requestId, ...args`) on the stream.
- JavaScript answers with `plugin-response` (`pluginId, requestId, error | null, ...result`).

Build outputs are flattened into `[name, bytes, name, bytes, …]`.
