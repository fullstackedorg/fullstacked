import path from "node:path";
import url from "node:url";
import child_process from "node:child_process";
import fs from "node:fs";
import version from "../../version.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import prettyBytes from "pretty-bytes";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

// build editor

child_process.execSync("npm run build", {
    cwd: rootDirectory,
    stdio: "inherit"
});

// build core

child_process.execSync("make wasm", {
    cwd: path.resolve(rootDirectory, "core", "build"),
    stdio: "inherit"
});

// build

child_process.execSync("npm run build", {
    cwd: currentDirectory,
    stdio: "inherit"
});

// upload to R2

const credentialsCF = dotenv.parse(
    fs.readFileSync(path.resolve(currentDirectory, "CLOUDFLARE.env"))
);

const s3Client = new S3Client({
    region: "auto", // CloudFlare R2 uses 'auto' as the region
    endpoint: `https://${credentialsCF.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: credentialsCF.R2_ACCESS_KEY_ID,
        secretAccessKey: credentialsCF.R2_SECRET_ACCESS_KEY
    }
});

const versionStr = `${version.major}.${version.minor}.${version.patch}`;

const baseKey = `wasm/${versionStr}/${version.build}`;

async function uploadFile(filename, ContentType) {
    const Key = `${baseKey}/${filename}`;

    const Body = fs.readFileSync(
        path.resolve(currentDirectory, "out", "bin", filename)
    );

    // Create the upload command
    const uploadCommand = new PutObjectCommand({
        Bucket: credentialsCF.R2_BUCKET_NAME,
        Key,
        Body,
        ContentType
    });

    // Execute the upload
    await s3Client.send(uploadCommand);

    console.log(
        `Successfully uploaded ${filename} (${prettyBytes(Body.byteLength)}) to R2 at key: ${Key}`
    );
}

await uploadFile("fullstacked.wasm", "application/octet-stream");
await uploadFile("wasm_exec.js", "application/octet-stream");
await uploadFile("editor.zip", "application/octet-stream");

// set version to current
const isRelease = process.argv.includes("--release");

const uploadCommand = new PutObjectCommand({
    Bucket: credentialsCF.R2_BUCKET_NAME,
    Key: isRelease ? `wasm/release.txt` : `wasm/beta.txt`,
    Body: JSON.stringify(version, null, 2),
    ContentType: "text/plain"
});

await s3Client.send(uploadCommand);
