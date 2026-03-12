import path from "node:path";
import fs from "node:fs";
import child_process from "node:child_process";

export function getVersion(cwd = process.cwd()) {
    const packageJsonFile = path.join(cwd, "package.json");

    if (!fs.existsSync(packageJsonFile)) {
        return null;
    }

    const packageJsonContent = fs.readFileSync(packageJsonFile, {
        encoding: "utf-8"
    });
    let packageJson: any;
    try {
        packageJson = JSON.parse(packageJsonContent);
    } catch (e) {
        return null;
    }

    if (typeof packageJson?.version !== "string") {
        return null;
    }

    const [major, minor, patch] = packageJson.version.split(".");

    const version: Partial<{
        major: number;
        minor: number;
        patch: number;
        build: string;
        branch: string;
        hash: string;
    }> = {
        major,
        minor,
        patch
    };

    try {
        version.branch = child_process
            .execSync("git rev-parse --abbrev-ref HEAD", {
                cwd
            })
            .toString()
            .trim();
    } catch (e) {}

    try {
        version.build = child_process
            .execSync(`git rev-list --count ${version.branch}`, {
                cwd
            })
            .toString()
            .trim();
    } catch (e) {}

    try {
        version.hash = child_process
            .execSync("git rev-parse HEAD", { cwd })
            .toString()
            .trim();
    } catch (e) {}

    return version;
}

export default getVersion();
