import path from "node:path";
import fs from "node:fs";
import child_process from "node:child_process";

export function getVersion(cwd = process.cwd()) {
    const packageJsonFile = path.join(cwd, "package.json");
    const packageJsonContent = fs.readFileSync(packageJsonFile, {
        encoding: "utf-8"
    });
    const packageJson = JSON.parse(packageJsonContent);

    const [major, minor, patch] = packageJson.version.split(".");

    const branch = child_process
        .execSync("git rev-parse --abbrev-ref HEAD", {
            cwd
        })
        .toString()
        .trim();
    const build = child_process
        .execSync(`git rev-list --count ${branch}`, {
            cwd
        })
        .toString()
        .trim();
    const hash = child_process
        .execSync("git rev-parse HEAD", { cwd })
        .toString()
        .trim();

    return {
        major,
        minor,
        patch,
        build,
        branch,
        hash
    };
}

export default getVersion();
