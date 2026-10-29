# fullstacked

```ts
import fullstacked from "fullstacked";
```

The [CLI](../cli.md) as a function. The npm `fullstacked` command, the app shell's `fullstacked` command and anything else that runs projects all go through `execute`. Every bundle also imports this module first (`import "fullstacked"`), which is what installs the bridge.

## execute

```ts
execute(command: string | string[], opts?: {
    stdio?: any[];         // [stdin, stdout, stderr]: objects with writeln() or write(); default: console
    keepGlobals?: boolean; // for --file: the script owns the process, keep the core WebSocket and window globals
}): Promise<number>        // exit code: 0 or 1
```

`command` is a full command line. Anything before the first `fullstacked` token is dropped. A string is split on whitespace, with **no quoting**, so pass an array when an argument contains spaces:

```ts
await fullstacked.execute("fullstacked --build ./my-app");
await fullstacked.execute(["fullstacked", "-e", "API=https://…", "./my-app"]);
```

What each flag does is described in the [CLI reference](../cli.md). In short:

- **Directory mode** registers the `-p` plugins, runs [`bundle`](bundle.md#bundle), prints warnings and errors, and stops there with `-b`. Otherwise it calls [`run`](run.md), then `fullstacked.open(ctx)` (unless `-n`), then the `-l` deep link.
- **`--file` mode** loads `.env` and `-e` into `process.env`, resolves the file with [`packages.resolve`](packages.md#resolve), runs [`bundleFile`](bundle.md#bundlefile), `import()`s the output with the extra arguments as `process.argv`, waits for open readline interfaces, and deletes the bundled `.js`.

## validateCommand

```ts
validateCommand(command: string | string[]): string[] | null
```

Splits `command` on whitespace and returns the tokens from the first `fullstacked` (or a path whose basename is `fullstacked`), or `null` when there is none. Shells use it to decide whether a line is a FullStacked command.

## getActiveInterfaces, waitForInterfaces

The readline interfaces that are still open, and a promise that settles once they have all closed. `--file` mode uses them to keep a script that is prompting alive.
