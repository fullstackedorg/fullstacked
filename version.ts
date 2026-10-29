import path from "node:path";
import fs from "node:fs";
import child_process from "node:child_process";
import url from "node:url";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

export function getVersion(cwd = currentDirectory) {
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
        major: string;
        minor: string;
        patch: string;
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

// the published version: MAJOR.MINOR.PATCH-BUILD for a beta, MAJOR.MINOR.PATCH
// for a stable release (FULLSTACKED_RELEASE=1). When publishing, a beta must be
// built from main, and a release from its vMAJOR.MINOR.PATCH tag.
export function getFullVersion(
    version: ReturnType<typeof getVersion>,
    options: { publish?: boolean; cwd?: string } = {}
) {
    const base = `${version.major}.${version.minor}.${version.patch}`;

    if (!process.env.FULLSTACKED_RELEASE) {
        if (options.publish && version.branch !== "main") {
            throw new Error(
                `beta releases are built from main, not ${version.branch}`
            );
        }
        return version.build ? `${base}-${version.build}` : base;
    }

    const tag = `v${base}`;
    const tags = child_process
        .execSync("git tag --points-at HEAD", {
            cwd: options.cwd ?? currentDirectory
        })
        .toString()
        .split("\n")
        .map((t) => t.trim());
    if (!tags.includes(tag)) {
        throw new Error(`release ${base} must be built from the ${tag} tag`);
    }
    return base;
}

export default getVersion();
