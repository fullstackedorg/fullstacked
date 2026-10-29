# Unavailable modules

Some Node built-ins can't exist in a webview: there is no process to spawn, no port to listen on, no V8 to reach. Importing them still **bundles**, so a package that imports one but never calls it (a common pattern in dependencies) keeps working. Calling into them fails at runtime.

Back to the [module table](index.md).

## child_process, async_hooks, module, vm, v8, sqlite

These resolve to a single stub (`lib/unavailable`): a default export that is a `Proxy` whose every property access **throws the string `"unavailable"`**. It is a string, not an `Error`, so there is no stack trace.

| Code                                    | Result                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `import cp from "child_process"`        | Bundles and runs                                                                             |
| `cp.spawn("ls")`                        | Throws `"unavailable"`                                                                       |
| `console.log(cp)`                       | May throw `"unavailable"` too, when the console inspects the object                          |
| `import { spawn } from "child_process"` | Bundles. `spawn` is `undefined`, and calling it throws `TypeError: spawn is not a function`. |
| `require("child_process").spawn`        | `undefined`. `require` returns the namespace, whose only member is `default`.                |

What to use instead:

| Instead of                             | Use                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child_process` to run another program | Nothing on device: the runtime runs JavaScript only. Run a script in-process with `import()`. Open another project in its own window with [`run`](../api/run.md). |
| `child_process` to run `git` or `npm`  | [`git`](../api/git.md) and [`packages`](../api/packages.md), built into the core                                                                                  |
| `async_hooks` (`AsyncLocalStorage`)    | Pass context explicitly                                                                                                                                           |
| `vm`                                   | `new Function()` or `import()` of a data URL, within the page's own realm                                                                                         |
| `sqlite` (`node:sqlite`)               | A WebAssembly SQLite (sql.js, wa-sqlite) persisting through `fs`                                                                                                  |
| `module` (`createRequire`)             | Static `import`. `require` is resolved at bundle time.                                                                                                            |

## http, https, http2, tls

There is no HTTP server, and HTTP clients go through `fetch`.

- `http`, `https` and `http2` export only `Agent`, which is an `Error` subclass named `Unavailable`. `new http.Agent()` **doesn't throw**: it builds an `Error` instance, so a package that makes an agent at load time still loads. `http.request`, `http.get`, `http.createServer`, `STATUS_CODES` and `METHODS` are `undefined`.
- `tls` exports `Server` and `TLSSocket` (the same `Unavailable` class), `connect`, `createServer`, `createSecureContext`, `checkServerIdentity` and `getCiphers`, which all throw `Error("unavailable")`. It also exports `rootCertificates` (`[]`) and the `DEFAULT_*` constants.

HTTP client libraries that ship a browser build (picked through the `browser` field, which esbuild honors) or that use `fetch` work, and the runtime's `fetch` gives them server-like reach because it has no CORS restriction. A library that only has a Node build on `http.request` doesn't work.

A project can't listen on a port on device. The host already serves the project's own files (see [Static files](../project-structure.md#static-files)). [Tunnels](../api/tunnel.md) carry _outbound_ connections only. They reach services elsewhere, but they don't expose one.

## Modules with no entry

`cluster`, `domain`, `inspector`, `punycode`, `repl`, `trace_events`, `wasi` and `node:sea` are not in the runtime's table. An import of them goes to normal `node_modules` resolution and fails the bundle with `Could not resolve "…"`, unless an npm package of that name is installed (`punycode` is, as a dependency of many packages).

`node:test` is a special case. The name `test` is taken by the runtime's internal bridge self-test module, so `import test from "node:test"` gives that module, not Node's test runner. Write tests to run under Node, not inside the runtime.
