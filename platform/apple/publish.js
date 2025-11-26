import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import child_process from "node:child_process";
import dotenv from "dotenv";
import version from "../../version.js";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

const tsgoLocation = path.resolve(rootDirectory, "core", "typescript-go");
const noTSGO = fs.readdirSync(tsgoLocation).length === 0;

// build editor

child_process.execSync(`npm run build ${noTSGO ? "-- --no-tsgo" : ""}`, {
    cwd: rootDirectory,
    stdio: "inherit"
});

// build core

child_process.execSync(
    `make darwin-static ios-arm64 -j4 ${noTSGO ? "NO_TSGO=1" : ""}`,
    {
        cwd: path.resolve(rootDirectory, "core", "build"),
        stdio: "inherit"
    }
);

// update version
const versionStr = `${version.major}.${version.minor}.${version.patch}`;

const xcodeProj = path.resolve(currentDirectory, "FullStacked.xcodeproj");
const xcodeFile = path.resolve(xcodeProj, "project.pbxproj");
const xcodeFileContent = fs.readFileSync(xcodeFile, { encoding: "utf-8" });
const xcodeFileUpdated = xcodeFileContent
    .replace(/MARKETING_VERSION = .*?;/g, `MARKETING_VERSION = ${versionStr};`)
    .replace(
        /CURRENT_PROJECT_VERSION = .*?;/g,
        `CURRENT_PROJECT_VERSION = ${version.build};`
    );
fs.writeFileSync(xcodeFile, xcodeFileUpdated);

// clean

const out = path.resolve(currentDirectory, "out");

if (fs.existsSync(out)) {
    fs.rmSync(out, { recursive: true });
}

// xcode build

const optionsPlist = path.resolve(currentDirectory, "exportOptions.plist");

const schemeiOS = "FullStacked-iOS";
const archivePathiOS = path.resolve(out, schemeiOS, "FullStacked.xcarchive");
const pkgDirectoryiOS = path.resolve(out, schemeiOS, "pkg");

child_process.execSync(
    `xcodebuild -project ${xcodeProj} -scheme ${schemeiOS} -sdk iphoneos -configuration Release clean`,
    {
        stdio: "inherit"
    }
);
child_process.execSync(
    `xcodebuild -project ${xcodeProj} -scheme ${schemeiOS} -sdk iphoneos -configuration Release archive -archivePath ${archivePathiOS}`,
    {
        stdio: "inherit"
    }
);
child_process.execSync(
    `xcodebuild -exportArchive -archivePath ${archivePathiOS} -exportOptionsPlist ${optionsPlist} -exportPath ${pkgDirectoryiOS} -allowProvisioningUpdates`,
    {
        stdio: "inherit"
    }
);

const schemeMacOS = "FullStacked-MacOS";
const archivePathMacOS = path.resolve(
    out,
    schemeMacOS,
    "FullStacked.xcarchive"
);
const pkgDirectoryMacOS = path.resolve(out, schemeMacOS, "pkg");

child_process.execSync(
    `xcodebuild ONLY_ACTIVE_ARCH=NO -project ${xcodeProj} -scheme ${schemeMacOS} -sdk macosx -configuration Release clean`,
    {
        stdio: "inherit"
    }
);
child_process.execSync(
    `xcodebuild ONLY_ACTIVE_ARCH=NO -project ${xcodeProj} -scheme ${schemeMacOS} -sdk macosx -configuration Release archive -archivePath ${archivePathMacOS}`,
    {
        stdio: "inherit"
    }
);
child_process.execSync(
    `xcodebuild ONLY_ACTIVE_ARCH=NO -exportArchive -archivePath ${archivePathMacOS} -exportOptionsPlist ${optionsPlist} -exportPath ${pkgDirectoryMacOS} -allowProvisioningUpdates`,
    {
        stdio: "inherit"
    }
);

// app store upload

const appleKeys = dotenv.parse(
    fs.readFileSync(path.resolve(currentDirectory, "APPLE_KEYS.env"))
);

const bundleiOSName = fs.readdirSync(pkgDirectoryiOS).find(item => item.endsWith(".ipa"));
const bundleiOS = path.resolve(pkgDirectoryiOS, bundleiOSName);
child_process.execSync(
    `xcrun altool --upload-app --file ${bundleiOS} -t ios --apiKey ${appleKeys.APPLE_API_KEY_ID} --apiIssuer ${appleKeys.APPLE_API_ISSUER} --show-progress`,
    {
        stdio: "inherit",
        env: {
            API_PRIVATE_KEYS_DIR: appleKeys.APPLE_API_KEY_DIRECTORY
        }
    }
);

const bundleMacOSName = fs.readdirSync(pkgDirectoryMacOS).find(item => item.endsWith(".pkg"));
const bundleMacOS = path.resolve(pkgDirectoryMacOS, bundleMacOSName);
child_process.execSync(
    `xcrun altool --upload-app --file ${bundleMacOS} -t macosx --apiKey ${appleKeys.APPLE_API_KEY_ID} --apiIssuer ${appleKeys.APPLE_API_ISSUER} --show-progress`,
    {
        stdio: "inherit",
        env: {
            API_PRIVATE_KEYS_DIR: appleKeys.APPLE_API_KEY_DIRECTORY
        }
    }
);
