import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import esbuild from "esbuild";

if (os.platform() === "darwin") {
    for (let port = 9000; port <= 9005; port++) {
        try {
            const pid = child_process.execSync(`lsof -t -i:${port}`).toString();
            if (pid) child_process.execSync(`kill -9 ${pid}`);
        } catch (e) {}
    }
}

const cacheDirectory = path.resolve("test", ".cache");

if (fs.existsSync(cacheDirectory))
    fs.rmSync(cacheDirectory, { recursive: true });

const build = (testFile: string) => {
    const outfile = path.resolve(cacheDirectory, "test.js");
    esbuild.buildSync({
        entryPoints: [path.resolve("test", testFile)],
        outfile,
        bundle: true,
        packages: "external",
        format: "esm"
    });
    return outfile;
};

// type checking
child_process.execSync(`node ./types.js`, { 
    stdio: "inherit",
    cwd: "./test"
 });

// basic tests
child_process.execSync(`node ${build("basic.ts")}`, {
    stdio: "inherit"
});

// deep links and git clone tests
child_process.execSync(`node ${build("deeplink-git.ts")}`, {
    stdio: "inherit"
});

// git commit and auto-update
child_process.execSync(`node ${build("commit-auto-update.ts")}`, {
    stdio: "inherit"
});
