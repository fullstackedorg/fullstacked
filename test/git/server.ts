import { execSync } from "node:child_process";
import { freePort } from "../server.ts";

const directory = "test/git/local-git-server";
// docker's own message goes in the error when a command fails
const stdio: ["ignore", "ignore", "pipe"] = ["ignore", "ignore", "pipe"];

// Starts the git server in docker, on a host port free on this host
export async function startGitServer() {
    const port = await freePort();
    execSync("docker compose up --build -d", {
        cwd: directory,
        env: { ...process.env, GIT_SERVER_PORT: `${port}` },
        stdio,
        // the build's progress goes to stderr too
        maxBuffer: 64 * 1024 * 1024
    });
    return { port, origin: `http://localhost:${port}` };
}

// populates or resets the repositories
export function resetGitServer() {
    execSync("docker compose exec git-server /bin/bash /home/setup.sh", {
        cwd: directory,
        stdio
    });
}

export function stopGitServer() {
    execSync("docker compose down", { cwd: directory, stdio });
}
