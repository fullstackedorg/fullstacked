import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import child_process from "node:child_process";
import { getVersion, getFullVersion } from "../../version.ts";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(currentDirectory, "package.json");

const isInject = process.argv.includes("--inject");

const rootDirectory = path.resolve(currentDirectory, "..", "..");
const version = getVersion(rootDirectory);

const platforms = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64"
];

if (isInject) {
    // checked before building: a beta from main, a release from its tag
    const fullVersion = getFullVersion(version, {
        publish: true,
        cwd: rootDirectory
    });

    child_process.execSync("node build.ts", {
        cwd: currentDirectory,
        stdio: "inherit"
    });

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    packageJson.version = fullVersion;
    packageJson.optionalDependencies = {};
    for (const target of platforms) {
        packageJson.optionalDependencies[`@fullstacked/${target}`] = fullVersion;
    }

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4));
} else {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    // keep the committed version free of the build number
    packageJson.version = `${version.major}.${version.minor}.${version.patch}`;
    delete packageJson.optionalDependencies;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4));
}
