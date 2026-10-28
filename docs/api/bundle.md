# bundle

```ts
import bundle from "fullstacked/bundle";
// or: import { bundle, bundleFile, esbuildVersion } from "fullstacked/bundle";
```

Bundles TypeScript and JavaScript with [esbuild](https://esbuild.github.io), which runs inside the Go core, so no Node or npm is needed on the device. This is what the CLI and the app run before opening a project. [Project structure](../project-structure.md) explains what goes in and what comes out.

## bundle

```ts
bundle(entryPoint?: string): Promise<EsbuildResult>
```

Builds a **project**. `entryPoint` is a directory (default `"."`) or a file. For a directory, the entry is the first of `index.tsx`, `index.ts`, `index.jsx` and `index.js` that exists.

It writes to `out/`, next to the entry:

| Output                      | From                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `out/index.ts.js`           | The bundle (named after the entry: `index.tsx.js`, `index.js.js`, …)                                                                         |
| `out/index.ts.css`          | All CSS imported from JavaScript, in import order                                                                                            |
| `out/<name>-<hash>.png`     | Images imported from JavaScript (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`). The import's value is the file's URL.                             |
| `out/*.css` and other files | Outputs of [build plugins](plugin.md#build-plugins)                                                                                          |
| `out/index.html`            | Generated: a viewport meta, one `<link rel="stylesheet">` per CSS output in the head, one `<script type="module">` per JS output in the body |

On a successful build, `out/` is **deleted and recreated**. Don't keep files there. If the build fails, the previous `out/` is left untouched.

Build plugins registered in the calling context run as part of the build (see [plugin](plugin.md#build-plugins)).

## bundleFile

```ts
bundleFile(entryPoint: string): Promise<EsbuildResult>
```

Builds **one file** into `<file>.js` next to it (`worker.ts` → `worker.ts.js`). There is no `out/`, no `index.html`, no image loaders and no build plugins. Use it for [workers](../project-structure.md#workers), scripts run with `fullstacked --file`, and plugins. `OutputFiles` are relative to the current working directory.

## esbuildVersion

```ts
esbuildVersion(): Promise<string>
```

The version of esbuild compiled into the core, for example `v0.28.2`.

## Result

```ts
type EsbuildResult = {
    OutputFiles: string[]; // paths of the written files, relative to the project root
    Errors: Message[];
    Warnings: Message[];
};

type Message = {
    ID?: string;
    PluginName?: string;
    Text?: string;
    Location?: {
        File: string;
        Namespace: string;
        Line: number;
        Column: number;
        Length: number;
        LineText: string;
        Suggestion: string;
    };
    Notes?: { Text: string; Location?: Message["Location"] }[];
    Detail?: unknown;
};
```

**A failed build doesn't reject.** Check `Errors`:

```ts
const result = await bundle.bundle("/my-app");
if (result.Errors.length) {
    for (const e of result.Errors) {
        console.error(`${e.Location?.File}:${e.Location?.Line}: ${e.Text}`);
    }
}
```

Errors from before esbuild runs come back the same way, with only `Text` set: `entry point not found`, `no entry point found in directory: …`, `failed to read file: …`, or a misconfigured plugin.

## Build options

The core runs esbuild with:

| Option                                    | Value                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bundle`                                  | `true`                                                                                                 |
| `format`                                  | `esm`                                                                                                  |
| `platform`                                | esbuild's default, `browser`, so package `browser` fields are honored                                  |
| `sourcemap`                               | none                                                                                                   |
| `minify`, `target`, `define`, `splitting` | not set                                                                                                |
| `jsx`                                     | esbuild's default, classic `React.createElement`, unless the project's `tsconfig.json` says otherwise  |
| `tsconfig`                                | Found by esbuild from the entry's directory (`paths`, `jsx`, `jsxImportSource`, …)                     |
| loaders                                   | by extension: `.ts`, `.tsx`, `.jsx`, `.js`, `.json`, `.css`, plus the image file loaders in `bundle()` |

Every entry gets `import "fullstacked";` prepended, which installs the bridge and the [globals](../node/index.md#globals) before your code runs.

These options aren't configurable. A project that needs a different esbuild setup can bundle in a build step of its own and commit the output (see [Prebuilt projects](../project-structure.md#prebuilt-projects)).

## Removed

`builderTailwindCSS()` and the core's Sass builder were removed. Calling the function only logs a warning. Use the [`@fullstacked/tailwindcss` and `@fullstacked/sass` build plugins](plugin.md#official-build-plugins).
