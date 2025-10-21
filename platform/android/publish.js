import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import child_process from "node:child_process";
import dotenv from "dotenv";
import version from "../../version.js";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

// build editor

child_process.execSync("npm run build", {
    cwd: rootDirectory,
    stdio: "inherit"
});

// build core

child_process.execSync("make android -j4", {
    cwd: path.resolve(rootDirectory, "core", "build"),
    stdio: "inherit"
});

// update version

const studioDirectory = path.resolve(currentDirectory, "studio");
const gradleFile = path.resolve(studioDirectory, "app", "build.gradle.kts");
const gradleFileContent = fs.readFileSync(gradleFile, {
    encoding: "utf-8"
});
const gradleFileUpdated = gradleFileContent
    .replace(
        /versionName = ".*?"/g,
        `versionName = "${version.major}.${version.minor}.${version.patch}"`
    )
    .replace(/versionCode = .*?\n/g, `versionCode = ${version.build}\n`);
fs.writeFileSync(gradleFile, gradleFileUpdated);

const androidKeys = dotenv.parse(
    fs.readFileSync(path.resolve(currentDirectory, "ANDROID_KEYS.env"))
);

// gradle build

child_process.execSync("./gradlew bundleRelease", {
    cwd: studioDirectory,
    stdio: "inherit",
    env: {
        JAVA_HOME: androidKeys.JAVA_HOME
    }
});

// pkg sign

const bundle = path.resolve(
    studioDirectory,
    "app",
    "build",
    "outputs",
    "bundle",
    "release",
    "app-release.aab"
);

child_process.execSync(
    `jarsigner -keystore ${androidKeys.FILE} -storepass ${androidKeys.PASSPHRASE} ${bundle} ${androidKeys.KEY}`,
    {
        cwd: studioDirectory,
        stdio: "inherit"
    }
);

// play console upload

child_process.execSync(
    `python upload.py org.fullstacked.editor ${bundle} ${version.major}.${version.minor}.${version.patch}`,
    {
        stdio: "inherit",
        cwd: currentDirectory
    }
);
