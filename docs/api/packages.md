# packages

```ts
import packages from "fullstacked/packages";
```

An npm-compatible package installer written in Go, inside the core. It reads and writes `package.json` and `package-lock.json`, and lays out `node_modules` the way npm does, following npm's own _reify_ step (arborist). It needs no Node or npm on the device. In the app, the shell's `npm install` and `packages install` commands use it.

## install

```ts
install(directory: string, saveDev: boolean, ...packages: string[]): Promise<EventEmitter<{ progress: Progress }>>
```

- **With package names**, it adds them: each spec is `name`, `name@range` (default `latest`) or a GitHub repository (`github:owner/repo`, `https://github.com/owner/repo`, `git+https://…`, `git+ssh://git@github.com/…`, `git://github.com/…`). The resolved version is saved as `^<version>`, or the GitHub spec as given, in `dependencies`, or in `devDependencies` when `saveDev` is `true`. `package.json` is rewritten with 2-space indentation.
- **With no names**, it installs what `package.json` declares, like `npm install`. If a `package-lock.json` exists, the tree comes straight from the lockfile, which isn't re-checked against `package.json`. Delete the lockfile to re-resolve.

```ts
const progress = await packages.install("/my-app", false, "react", "react-dom");
progress.on("progress", (p) => {
    if (p.stage === "Extracting")
        console.log(p.name, p.version, Math.round(p.progress * 100) + "%");
    if (p.stage === "Done") console.log(`${p.progress} packages`);
});
```

```ts
type Progress = {
    stage: string; // see below
    name?: string;
    version?: string;
    progress?: number; // 0..1 while extracting; the number of packages downloaded on Done
    error?: string;
};
```

| Stage                | Meaning                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `Initialization`     | Reading `package.json`                                                              |
| `Verifying Lockfile` | Installing straight from `package-lock.json` (no names given and a lockfile exists) |
| `Resolving`          | Fetching metadata and resolving the tree                                            |
| `Extracting`         | Downloading and extracting one package (`name`, `version`, `progress`)              |
| `Finalizing`         | Writing `package-lock.json` and `node_modules/.package-lock.json`                   |
| `Done`               | Finished. The stream ends.                                                          |
| `Error`              | The stream fails with `error`                                                       |

### Behavior

- **Registry**: `https://registry.npmjs.org/`. Up to 10 downloads at a time. Metadata is cached for the run.
- **Lockfiles**: `package-lock.json` is written after every install. The hidden lockfile `node_modules/.package-lock.json` is written last, and it is trusted only if it's the newest entry in `node_modules`, as npm does.
- **Reify**: a package already in `node_modules` with the same version and integrity is kept. A changed package is moved aside, replaced, and restored if the install fails. An install that was interrupted is repaired on the next run.
- **Flags**: `dev`, `optional` and `peer` are computed as npm does. Packages whose `os` or `cpu` don't match the device are skipped.
- **Git dependencies** are cloned with the core's git and trimmed per `.npmignore`/`.gitignore`, like `npm pack`.
- **`fullstacked` itself is skipped.** The runtime is not a dependency of a project, even when `package.json` lists it for types.
- **No lifecycle scripts run.** `preinstall`, `install` and `postinstall` are recorded (`hasInstallScript`) but never executed, so packages that build native addons or download binaries in `postinstall` won't have them. Native addons can't run in the runtime anyway.

## uninstall

```ts
uninstall(directory: string, ...packages: string[]): Promise<EventEmitter<{ progress: Progress }>>
```

Removes the names from `dependencies` and `devDependencies`, deletes them from `node_modules`, and reconciles the rest of the tree (the stage is `Uninstalling`, then the install stages).

## audit

```ts
audit(directory: string): Promise<any>
```

Posts the installed versions from `package-lock.json` to npm's bulk advisory endpoint (`/-/npm/v1/security/advisories/bulk`) and resolves with the report, keyed by package name. It fails if there's no `package-lock.json`.

## resolve

```ts
resolve(moduleName: string, startDir?: string): Promise<string>
```

Node-style module resolution. A relative or absolute spec is tried as a file (as is, then with `.ts`, `.tsx`, `.js`, `.json`, `.node`) and as a directory (`package.json` `main`, a string `exports`, `index.*`). A bare name walks up `node_modules` from `startDir` (default: the current working directory) to the project root. It resolves with a path relative to the working directory, using forward slashes, or rejects with `cannot find module '…' from '…'`. The CLI uses it to find plugins (`-p @fullstacked/sass`) and scripts (`--file`).

## addNodePath

```ts
addNodePath(inputPath: string): Promise<void>
```

Reserved. It validates that the path stays in the project and currently has no other effect.
