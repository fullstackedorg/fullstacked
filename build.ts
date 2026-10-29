import os from "node:os";
import child_process from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import version from "./version.ts";
import url from "node:url";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

// types

child_process.execSync("go run ./generate.go", {
    cwd: path.join(currentDirectory, "types")
});

// version

fs.writeFileSync(
    path.join(
        currentDirectory,
        "core/internal/bundle/lib/process/version.json"
    ),
    JSON.stringify(version)
);

// core

const platform = os.platform();
const arch = os.arch();

if (platform === "win32") {
    child_process.execSync(`call ./windows.bat ${arch}`, {
        stdio: "inherit",
        cwd: path.join(currentDirectory, "core/build")
    });
} else {
    const target_name = platform + "-" + arch + "-shared";
    child_process.execSync(`make ${target_name}`, {
        stdio: "inherit",
        cwd: path.join(currentDirectory, "core/build")
    });
}

// plugins

const pluginsDir = path.join(currentDirectory, "plugins");

async function copyPlugin(plugin: string) {
    const pluginPath = path.join(pluginsDir, plugin);

    if (!fs.existsSync(path.join(pluginPath, "package.json"))) return;

    child_process.execSync("npm run build", {
        cwd: pluginPath,
        stdio: "inherit"
    });

    const pkgJsonPath = path.join(pluginPath, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const pkgName = pkgJson.name;
    const destPath = path.resolve("node_modules", pkgName);

    if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { recursive: true, force: true });
    }

    await fs.promises.cp(pluginPath, destPath, {
        recursive: true,
        force: true,
        filter: (src) => {
            // the plugin's tests run from this repository, not from the copy
            const relative = path.relative(pluginPath, src).split(path.sep);
            return !relative.includes("node_modules") && relative[0] !== "test";
        }
    });
}

const plugins = (await fs.promises.readdir(pluginsDir, { withFileTypes: true }))
    .filter((dirent) => dirent.isDirectory())
    .map(({ name }) => name);
await Promise.all(plugins.map(copyPlugin));

console.log(
    `\nBuilt FullStacked v${version.major}.${version.minor}.${version.patch}\n` +
        `\tbuild: ${version.build}\n` +
        `\tbranch: ${version.branch}\n` +
        `\thash: ${version.hash.slice(0, 8)}\n` +
        `\tplatform: ${platform}-${arch}\n`
);
