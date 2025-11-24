import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import child_process from "node:child_process";
import zlib from "node:zlib";
import tar from "tar-stream";
import dotenv from "dotenv";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import prettyBytes from "pretty-bytes";
import version from "../../version.js";

const isRelease = process.argv.includes("--release");

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

// prepare fullstacked_modules

await import("./build-modules.js");

// update version

const versionStr = `${version.major}.${version.minor}.${version.patch}`;
const packageJsonFilePath = path.resolve(currentDirectory, "package.json");
const packageJson = JSON.parse(
    fs.readFileSync(packageJsonFilePath, { encoding: "utf-8" })
);
packageJson.version = isRelease ? versionStr : `${versionStr}-${version.build}`;

fs.writeFileSync(packageJsonFilePath, JSON.stringify(packageJson, null, 4));

// build core shared lib for current platform

const platform = os.platform();
const currentArch = os.arch();
let command =
    platform === "win32"
        ? "call ./windows.bat arm64 NO_TSGO=1 && call ./windows.bat x64 NO_TSGO=1"
        : platform === "linux"
          ? `make ${platform}-${currentArch}-shared -j4 NO_TSGO=1`
          : `make ${platform}-x64-shared ${platform}-arm64-shared -j4 NO_TSGO=1`;
          
child_process.execSync(command, {
    cwd: path.resolve(rootDirectory, "core", "build"),
    stdio: "inherit"
});

// build node bindings for current platform

child_process.execSync(`node ./build.js --binding --arch ${currentArch}`, {
    cwd: currentDirectory,
    stdio: "inherit"
});

if (platform !== "linux") {
    child_process.execSync(
        `node ./build.js --binding --arch ${currentArch === "x64" ? "arm64" : "x64"}`,
        {
            cwd: currentDirectory,
            stdio: "inherit"
        }
    );
}

// gzip both packages

const libExt = platform === "win32" ? "dll" : "so";

async function packageArch(arch) {
    const files = [
        path.resolve(
            rootDirectory,
            "core",
            "bin",
            `${platform}-${arch}.${libExt}`
        ),
        path.resolve(currentDirectory, `${platform}-${arch}.node`)
    ];

    const pack = tar.pack();
    const gzip = zlib.createGzip();
    const outputPath = path.resolve(
        currentDirectory,
        `${platform}-${arch}-${packageJson.version}.tgz`
    );
    const output = fs.createWriteStream(outputPath);

    pack.pipe(gzip).pipe(output);

    for (const filePath of files) {
        const stat = fs.statSync(filePath);
        const stream = pack.entry({
            name: path.basename(filePath),
            size: stat.size
        });

        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(stream);

        await new Promise((resolve, reject) => {
            stream.on("finish", resolve);
            stream.on("error", reject);
        });
    }

    pack.finalize();

    return new Promise((resolve, reject) => {
        output.on("finish", () => resolve([outputPath, arch]));
        output.on("error", reject);
    });
}

const builds =
    platform === "linux"
        ? [packageArch(currentArch)]
        : [packageArch("x64"), packageArch("arm64")];
const buildPackages = await Promise.all(builds);

// upload to R2

const credentialsCF = dotenv.parse(
    fs.readFileSync(path.resolve(currentDirectory, "CLOUDFLARE.env"))
);

const s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${credentialsCF.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: credentialsCF.R2_ACCESS_KEY_ID,
        secretAccessKey: credentialsCF.R2_SECRET_ACCESS_KEY
    }
});

await Promise.all(
    buildPackages.map(([outputPath, arch]) => uploadPackage(outputPath, arch))
);

function uploadPackage(packageFilePath, arch) {
    const packageName = path.basename(packageFilePath);
    console.log(
        `Uploading [${packageName}] ${prettyBytes(fs.statSync(packageFilePath).size)}`
    );
    const fileBuffer = fs.readFileSync(packageFilePath);
    const s3Key = `lib/${platform}/${arch}/${versionStr}/${packageName}`;

    const uploadCommand = new PutObjectCommand({
        Bucket: credentialsCF.R2_BUCKET_NAME,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: "application/tar+gzip"
    });

    return s3Client.send(uploadCommand);
}

// check if version is already on npmjs

const packageInfoResponse = await fetch(
    "https://registry.npmjs.org/fullstacked"
);
const packageInfo = await packageInfoResponse.json();
const versions = Object.keys(packageInfo.versions);

if (!versions.includes(packageJson.version)) {
    const command = isRelease ? "npm publish" : "npm publish --tag beta";
    child_process.execSync(command, {
        cwd: currentDirectory,
        stdio: "inherit"
    });
}

console.log("Done");
