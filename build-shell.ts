// The shell as the apps ship it: `npm run build:shell:release`
//
// Builds shell/ to shell/out with build plugins, then copies extra files into
// shell/out. Every app build (Xcode, Gradle, Windows, Linux) runs it.
//
//   -p, --plugin <plugin>   a build plugin: a path or a package name.
//                           Repeatable. Replaces the default, plugins/onboarding.
//   -f, --files <dir>       a folder whose contents are copied into shell/out
//                           after the build. Repeatable.
//
// Or, for builds that can't change the command (an IDE's build step), the
// same lists in the environment, comma separated:
//
//   SHELL_PLUGINS=<plugin>,…   replaces the default; empty for no plugin
//   SHELL_FILES=<dir>,…
//
// Flags win over the environment. Only one plugin can replace the shell's
// "./auto" import (its startup hook): to keep the onboarding with another
// startup, pass a plugin that wraps it (shellStartupPlugin in
// plugins/onboarding/index.ts) instead of the onboarding itself.
//
// The CLI reads files only inside its root, this repository. A plugin folder
// outside of it is copied to .cache/shell-plugins/<name> first. Its imports
// resolve from there, then from the repository's node_modules (where
// `@fullstacked/onboarding` is the plugins/onboarding workspace).

import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const rootDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const shellOut = path.join(rootDirectory, "shell", "out");
const externalPlugins = path.join(rootDirectory, ".cache", "shell-plugins");

const DEFAULT_PLUGINS = ["plugins/onboarding"];

function flagValues(names: string[], args: string[]) {
    const values: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (!names.includes(args[i])) continue;
        const value = args[i + 1];
        if (value === undefined || value.startsWith("-")) {
            throw new Error(`${args[i]} needs a value`);
        }
        values.push(value);
        i++;
    }
    return values;
}

function envList(name: string) {
    const value = process.env[name];
    if (value === undefined) return null;
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

const args = process.argv.slice(2);
const pluginFlags = flagValues(["-p", "--plugin"], args);
const filesFlags = flagValues(["-f", "--files"], args);

const plugins = pluginFlags.length
    ? pluginFlags
    : (envList("SHELL_PLUGINS") ?? DEFAULT_PLUGINS);
const files = filesFlags.length ? filesFlags : (envList("SHELL_FILES") ?? []);

// what the CLI gets for a plugin: a path relative to the repository (with /),
// or the package name as is
function pluginArgument(plugin: string) {
    const pluginPath = path.resolve(rootDirectory, plugin);
    if (!fs.existsSync(pluginPath)) {
        if (DEFAULT_PLUGINS.includes(plugin)) {
            throw new Error(
                `${plugin} is missing: git submodule update --init ${plugin}`
            );
        }
        // a package, resolved by the CLI from shell/ or the repository
        return plugin;
    }

    let relative = path.relative(rootDirectory, pluginPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        const copy = path.join(externalPlugins, path.basename(pluginPath));
        fs.cpSync(pluginPath, copy, {
            recursive: true,
            filter: (src) => path.basename(src) !== ".git"
        });
        relative = path.relative(rootDirectory, copy);
    }
    return relative.split(path.sep).join("/") || ".";
}

fs.rmSync(externalPlugins, { recursive: true, force: true });
const pluginArgs = plugins.flatMap((plugin) => ["-p", pluginArgument(plugin)]);

console.log(
    `Building the shell with ${plugins.length ? plugins.join(", ") : "no plugin"}`
);

// index.ts is `npm start`: it builds the core and the Node addon, then runs
// the CLI from the repository
const build = child_process.spawnSync(
    process.execPath,
    ["index.ts", "fullstacked", "--build", ...pluginArgs, "shell"],
    { cwd: rootDirectory, stdio: "inherit" }
);
fs.rmSync(externalPlugins, { recursive: true, force: true });
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}

// after the build: bundling replaces shell/out
for (const dir of files) {
    const source = path.resolve(rootDirectory, dir);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`${dir} isn't a folder`);
    }
    fs.cpSync(source, shellOut, { recursive: true, force: true });
    console.log(`Copied ${dir} into shell/out`);
}
