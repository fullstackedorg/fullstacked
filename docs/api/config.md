# config

```ts
import config from "fullstacked/config";
```

Per-project key/value settings, as strings. They are stored in the project's git directory, so they stay on the device: they aren't committed or pushed, and they survive a `git reset --hard` or a re-clone over the same directory.

| Function                               | Returns                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `get(key)`                             | `Promise<string \| undefined>`                                                      |
| `set(key, value)`                      | `Promise<void>`. `value` must be a string, otherwise it rejects with a `TypeError`. |
| `list()`                               | `Promise<Record<string, string>>`                                                   |
| `del(key)` (also exported as `delete`) | `Promise<void>`                                                                     |

`getConfig`, `setConfig`, `listConfig` and `deleteConfig` are aliases.

```ts
await config.set("theme", "dark");
const theme = await config.get("theme"); // "dark"
```

## Storage

The settings are a flat JSON object in `<project root>/.git/config.json`. When `.git` is a file (a worktree or submodule), the `gitdir:` it points to is used. The directory is created if needed, so a project without git gets a `.git/` folder holding only `config.json`. A file that isn't valid JSON reads as empty.

The context's root is used, so `config` called from a project reads that project's settings. The shell's `config get|set|delete|list` commands work on the app's own settings.

## Keys the runtime reads

### initialDirectory

When a context starts (from a host, [`run`](run.md) or the CLI), and it isn't started in _safe_ mode, the core reads `initialDirectory` and moves the context's root to `<root>/<initialDirectory>`. This lets a repository keep its app in a subdirectory:

```ts
await config.set("initialDirectory", "app");
```

Safe mode exists to recover from a bad value. It is available as `fullstacked --safe`, `run({ safe: true })`, Cmd+Shift+T in the macOS app, and `--safe` on Linux.

### FullStacked app settings

The app's shell reads two more keys from its own config:

- `initScript`: shell commands run at startup, one per line.
- `expectedKeyboard`: turns on the on-screen keyboard helper.
