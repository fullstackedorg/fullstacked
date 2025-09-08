import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import child_process from "node:child_process";
import version from "../../version.js";

/*
* TO SELECT RELEASE OR BETA APP, RUN BEFORE PUBLISH
* 
* msstore init
* 
* IN platform/windows DIRECTORY
*/

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

// build editor

child_process.execSync("npm run build -- -- --production", {
    cwd: rootDirectory,
    stdio: "inherit"
});

// build core

child_process.execSync("cmd.exe /c windows.bat", {
    cwd: path.resolve(rootDirectory, "core", "build"),
    stdio: "inherit"
});

// update version

const versionStr = `${version.major}.${version.minor}.${version.build}.0`
const packageFile = path.resolve(currentDirectory, "Package.appxmanifest");
let packageContent = fs.readFileSync(packageFile, { encoding: "utf-8" });
packageContent = packageContent.replace(/\bVersion="\d+\.\d+\.\d+\.\d+"/g, `Version="${versionStr}"`)
fs.writeFileSync(packageFile, packageContent);

// clean

const appPackages = path.resolve(currentDirectory, "AppPackages");
if(fs.existsSync(appPackages))
    fs.rmSync(appPackages, { recursive: true })

// msstore

child_process.execSync("msstore package", {
    cwd: currentDirectory,
    stdio: "inherit"
});

child_process.execSync("msstore publish -prp 100", {
    cwd: currentDirectory,
    stdio: "inherit"
});
