import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import os from "node:os";
import url from "node:url";
import dotenv from "dotenv";
import version from "../../version.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

const arch = os.arch();

// build editor

child_process.execSync("npm run build", {
    cwd: rootDirectory,
    stdio: "inherit"
});

// build core

child_process.execSync(`make linux-${arch}-static -j4`, {
    cwd: path.resolve(rootDirectory, "core", "build"),
    stdio: "inherit"
});

// update version
const versionStr = `${version.major}.${version.minor}.${version.patch}`;

function updateControlFile(framework) {
    const controlFile = path.resolve(currentDirectory, `control-${framework}`);
    const controlFileContent = fs.readFileSync(controlFile, {
        encoding: "utf-8"
    });
    const controlFileContentUpdated = controlFileContent.replace(
        /Version\:.*\n/g,
        `Version: ${versionStr}\n`
    );
    fs.writeFileSync(controlFile, controlFileContentUpdated);
}

// build GTK
updateControlFile("gtk");

child_process.execSync(`sh ./build-gtk.sh ${arch}`, {
    cwd: currentDirectory,
    stdio: "inherit"
});

// pkg GTK

child_process.execSync(`sh ./pkg.sh`, {
    cwd: currentDirectory,
    stdio: "inherit"
});

const debPackageGTK = path.resolve(
    currentDirectory,
    `fullstacked-${versionStr}-${version.build}-linux-${arch}-gtk.deb`
);

fs.renameSync(path.resolve(currentDirectory, "fullstacked.deb"), debPackageGTK);

// build Qt
updateControlFile("qt");

child_process.execSync(`cmake -DARCH=${arch} .`, {
    cwd: currentDirectory,
    stdio: "inherit"
});

child_process.execSync(`make -j4`, {
    cwd: currentDirectory,
    stdio: "inherit"
});

// pkg Qt

const debPackageQt = path.resolve(
    currentDirectory,
    `fullstacked-${versionStr}-${version.build}-linux-${arch}-qt.deb`
);

child_process.execSync(`sh ./pkg.sh`, {
    cwd: currentDirectory,
    stdio: "inherit"
});

fs.renameSync(path.resolve(currentDirectory, "fullstacked.deb"), debPackageQt);

// Upload to R2

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

await uploadDebToR2(debPackageGTK);
await uploadDebToR2(debPackageQt);

const versionTxtFile = process.argv.includes("--release")
    ? `linux-builds/${arch}/release.txt`
    : `linux-builds/${arch}/beta.txt`;

const uploadCommand = new PutObjectCommand({
    Bucket: credentialsCF.R2_BUCKET_NAME,
    Key: versionTxtFile,
    Body: new TextEncoder().encode(JSON.stringify(version, null, 2)),
    ContentType: "text/plain"
});

await s3Client.send(uploadCommand);

async function uploadDebToR2(debFilePath) {
    try {
        // Read the .deb file
        const fileBuffer = fs.readFileSync(debFilePath);
        const fileName = path.basename(debFilePath);

        // Construct the S3 key: /[arch]/[version]/filename
        const s3Key = `linux-builds/${arch}/${versionStr}/${fileName}`;

        // Create the upload command
        const uploadCommand = new PutObjectCommand({
            Bucket: credentialsCF.R2_BUCKET_NAME,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: "application/vnd.debian.binary-package"
        });

        // Execute the upload
        await s3Client.send(uploadCommand);

        console.log(`Successfully uploaded ${fileName} to R2 at key: ${s3Key}`);
    } catch (error) {
        console.error("Error uploading .deb file to R2:", error);
        throw new Error(`Failed to upload ${debFilePath}: ${error.message}`);
    }
}
