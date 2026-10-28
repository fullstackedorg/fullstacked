# System modules

`fs`, `path`, `os` and `process` call the Go core over the [bridge](../bridge.md). Most of these calls are **synchronous** bridge calls, so `fs.readFileSync` really blocks the page until the core answers, as it does in Node. The async forms are async bridge calls, and the core runs them off the page's thread.

Back to the [module table](index.md).

## The project sandbox

Every path goes through the core's `ResolveWithContext`, which resolves it against the [context](../architecture.md#contexts) that made the call:

- An absolute path (`/data.json`, `\data.json`) is relative to the **project root**, not the machine's root. `/` _is_ the project directory.
- A relative path is relative to the project root joined with `process.cwd()`.
- A path that resolves outside the root (`../../etc/passwd`) is clamped to the root itself.
- The `build:` prefix (`build:/index.js`) addresses the context's build directory instead of the project root. The runtime's own modules use it. Projects normally don't need it.

A project can't read or write outside its own directory through `fs`. Every platform host and the CLI apply the same rule, because the core does the resolving.

## fs

| Function            | Sync             | Callback | `fs/promises` | Notes                                                                                                                                       |
| ------------------- | ---------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `existsSync`        | ✓                |          |               |                                                                                                                                             |
| `stat`              | `statSync`       | ✓        | ✓             | `isFile()`, `isDirectory()`, `size`, `mode`, `atime`/`mtime`/`ctime`/`birthtime` (and `*Ms`). No `isSymbolicLink()`. Symlinks are followed. |
| `readFile`          | `readFileSync`   | ✓        | ✓             | A `Buffer`, or a string with `encoding` (any `TextDecoder` label)                                                                           |
| `readdir`           | `readdirSync`    | ✓        | ✓             | `withFileTypes` (Dirent with `name`, `parentPath`, `isFile()`, `isDirectory()`) and `recursive`                                             |
| `writeFile`         | `writeFileSync`  | ✓        | ✓             | `string` or `Uint8Array`. Options such as `mode` and `flag` are ignored.                                                                    |
| `appendFile`        | `appendFileSync` | ✓        | ✓             |                                                                                                                                             |
| `mkdir`             | `mkdirSync`      | ✓        | ✓             | Always recursive (`MkdirAll`, mode 0755)                                                                                                    |
| `rm`                | `rmSync`         | ✓        | ✓             | Always recursive and forced (`RemoveAll`)                                                                                                   |
| `unlink`            | `unlinkSync`     | ✓        | ✓             |                                                                                                                                             |
| `rename`            | `renameSync`     | ✓        | ✓             |                                                                                                                                             |
| `cp`                | `cpSync`         | ✓        | ✓             | Files and directories, recursive                                                                                                            |
| `realpath`          | `realpathSync`   |          |               | Same as `path.resolve`. No symlink resolution.                                                                                              |
| `createReadStream`  |                  |          |               | A core stream, read in `highWaterMark` chunks (64 KiB default), `start`/`end`, `encoding`, `signal`                                         |
| `createWriteStream` |                  |          |               | A core stream; emits `open`, then writes in order                                                                                           |
| `constants`         |                  |          |               | `F_OK`, `O_*`, `S_I*`, `COPYFILE_*`, … (macOS values)                                                                                       |

**Not provided**: file descriptors (`open`, `read`, `write`, `close`, `FileHandle`), `lstat`, `access`, `chmod`/`chown`, `utimes`, `symlink`/`readlink`/`link`, `truncate`, `watch`/`watchFile`, `mkdtemp`, `opendir`, `copyFile` (use `cp`), `exists` (callback form), and `fs.promises.realpath`.

**Errors.** A failed core call rejects or throws an `Error` whose message is `error from bridge: [<Go error>]`, for example `error from bridge: [open /…/missing.json: no such file or directory]`. These errors have **no `code` property** (`ENOENT`, `EEXIST`, …). Only `createReadStream` and `createWriteStream` map the open error to Node's `code` and message. Use `existsSync`, or check the message, when you need to tell "missing" apart from other errors.

## path

`sep`, `isAbsolute`, `resolve`, `join`, `normalize`, `parse`, `extname`, `dirname`, `basename` and `relative`. `resolve`, `join`, `normalize`, `parse` and `relative` are synchronous core calls, which use Go's `path/filepath` on the host's platform. `path.posix` and `path.win32` are the same object. `sep` is `\` on Windows and `/` elsewhere. `resolve()` starts from `process.cwd()`, which is relative to the project root, so `path.resolve("a")` returns `/a` when cwd is `/`.

**Not provided**: `delimiter`, `format`, `toNamespacedPath` and `matchesGlob`. The `path/posix` and `path/win32` subpaths are not mapped either; use `path.posix`.

## os

| Function              | Value                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `platform()`          | The host's Go `GOOS` mapped to Node's names (`darwin`, `linux`, `win32`, `android`, …). Cached after the first call. |
| `arch()`              | `arm64`, `x64`, …                                                                                                    |
| `endianness()`        | `LE` or `BE`                                                                                                         |
| `type()`, `release()` | `uname` sysname and release                                                                                          |
| `hostname()`          |                                                                                                                      |
| `tmpdir()`            | `/.tmp`, inside the project, created on first use                                                                    |

**Not provided**: `homedir`, `userInfo`, `cpus`, `totalmem`, `freemem`, `networkInterfaces`, `uptime`, `loadavg`, `EOL`, `constants`, `availableParallelism`, `machine` and `version`.

## process

`process` is a global and can also be imported. Under `fullstacked --file` the script runs in Node, so the global `process` there is Node's own. In a webview or worker it is the runtime's, with these members:

| Member                  | Behavior                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                   | The context's environment (see [Project structure](../project-structure.md#environment-variables)). In a webview, every read of `process.env` is a sync core call that returns a **fresh object**, so `process.env.X = "y"` doesn't persist. Keep your own copy if you need to change it. |
| `argv`                  | The `argv` query parameters of the page's script URL. Empty for an app opened normally.                                                                                                                                                                                                   |
| `cwd()` / `chdir(dir)`  | The context's working directory, relative to the project root (starts at `/`)                                                                                                                                                                                                             |
| `exit()`                | Closes the app's window on the host, or ends the worker. Under the CLI it stops the core context.                                                                                                                                                                                         |
| `nextTick(fn, ...args)` | A queue drained in one microtask, in order. Ticks queued while it drains run in the same drain.                                                                                                                                                                                           |
| `hrtime([prev])`        | From `performance.now()`                                                                                                                                                                                                                                                                  |
| `versions.fullstacked`  | `{ major, minor, patch, build, branch, hash }` of the running core                                                                                                                                                                                                                        |
| `version`               | `""`                                                                                                                                                                                                                                                                                      |
| `platform`, `arch`      | Not on `process`. Use `os.platform()` and `os.arch()`.                                                                                                                                                                                                                                    |
| `stdout`, `stderr`      | Node's under the CLI. In a webview, `write()` of a string goes to `console.log`/`console.error`.                                                                                                                                                                                          |
| `stdin`                 | Node's under the CLI. In a webview it is an inert object.                                                                                                                                                                                                                                 |
| `on`, `once`, `emit`, … | No-ops. `process.on("exit")` and `process.on("uncaughtException")` never fire.                                                                                                                                                                                                            |
| `umask()`               | `0`                                                                                                                                                                                                                                                                                       |
| `binding()`             | Throws                                                                                                                                                                                                                                                                                    |
| `browser`, `title`      | `true`, `"browser"`                                                                                                                                                                                                                                                                       |

`nextTick` used to be a `setTimeout(0)`. Browsers clamp chained timers to 4 ms and throttle hidden pages, which made every package that defers with `nextTick` wait per chunk. The microtask queue is as close to Node's tick queue as a page allows. One difference remains: a throwing callback is reported as an uncaught error, and the remaining ticks run on the next microtask.
