import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import url from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import prettyBytes from "pretty-bytes";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import version from "../../version.ts";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, "..", "..");

// 1. Credentials Handling
async function getCredentials() {
    const envFile = path.resolve(currentDirectory, "cloudflare.env");
    const legacyEnvFile = path.resolve(currentDirectory, ".env");
    const legacyCFFile = path.resolve(currentDirectory, "CLOUDFLARE.env");

    let envConfig = {};
    if (fs.existsSync(envFile)) {
        envConfig = dotenv.parse(fs.readFileSync(envFile, "utf-8"));
    } else if (fs.existsSync(legacyEnvFile)) {
        envConfig = dotenv.parse(fs.readFileSync(legacyEnvFile, "utf-8"));
    } else if (fs.existsSync(legacyCFFile)) {
        envConfig = dotenv.parse(fs.readFileSync(legacyCFFile, "utf-8"));
    }

    const requiredKeys = [
        "CLOUDFLARE_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME"
    ];

    const credentials = {};
    for (const key of requiredKeys) {
        credentials[key] = process.env[key] || envConfig[key] || "";
    }

    const hasMissing = requiredKeys.some((key) => !credentials[key]);
    if (hasMissing) {
        const rl = readline.createInterface({ input, output });
        try {
            for (const key of requiredKeys) {
                if (!credentials[key]) {
                    const answer = await rl.question(`Enter ${key}: `);
                    credentials[key] = answer.trim();
                }
            }
        } finally {
            rl.close();
        }

        const envContent =
            Object.entries(credentials)
                .filter(([_, v]) => Boolean(v))
                .map(([k, v]) => `${k}=${v}`)
                .join("\n") + "\n";
        fs.writeFileSync(envFile, envContent, "utf-8");
        console.log(`Saved credentials to ${envFile}`);
    }

    return credentials;
}

const credentials = await getCredentials();

const s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${credentials.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: credentials.R2_ACCESS_KEY_ID,
        secretAccessKey: credentials.R2_SECRET_ACCESS_KEY
    }
});

// 2. Build main app
console.log("Building main app...");
child_process.execSync(
    "npm start -- fullstacked app --plugin @fullstacked/tailwindcss --build",
    {
        cwd: rootDirectory,
        stdio: "inherit"
    }
);

// 3. Build core static libraries
console.log("Building core Linux static libraries...");
child_process.execSync("make linux-arm64-static linux-x64-static -j4", {
    cwd: path.resolve(rootDirectory, "core", "build"),
    stdio: "inherit"
});

// 4. Determine Version
const patch = version.patch ? version.patch.split("-")[0] : "0";
const versionStr = version.build
    ? `${version.major}.${version.minor}.${patch}-${version.build}`
    : `${version.major}.${version.minor}.${patch}`;

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

// 5. Build all 4 Linux releases
const targets = [
    { arch: "arm64", framework: "gtk" },
    { arch: "arm64", framework: "qt" },
    { arch: "x64", framework: "gtk" },
    { arch: "x64", framework: "qt" }
];

const releaseFiles = [];

for (const target of targets) {
    console.log(`\n========================================`);
    console.log(
        `Building Linux ${target.arch} (${target.framework.toUpperCase()})...`
    );
    console.log(`========================================\n`);

    updateControlFile(target.framework);

    if (target.framework === "gtk") {
        child_process.execSync(`sh ./build-gtk.sh ${target.arch}`, {
            cwd: currentDirectory,
            stdio: "inherit"
        });
    } else if (target.framework === "qt") {
        const cmakeCache = path.resolve(currentDirectory, "CMakeCache.txt");
        if (fs.existsSync(cmakeCache)) {
            fs.rmSync(cmakeCache);
        }
        const cmakeFiles = path.resolve(currentDirectory, "CMakeFiles");
        if (fs.existsSync(cmakeFiles)) {
            fs.rmSync(cmakeFiles, { recursive: true });
        }

        let cmakeFlags = `-DARCH=${target.arch}`;
        const hostArch = process.arch === "x64" ? "x64" : "arm64";
        if (target.arch === "x64" && hostArch !== "x64") {
            cmakeFlags +=
                " -DCMAKE_C_COMPILER=x86_64-linux-gnu-gcc -DCMAKE_CXX_COMPILER=x86_64-linux-gnu-g++";
        } else if (target.arch === "arm64" && hostArch !== "arm64") {
            cmakeFlags +=
                " -DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++";
        }

        child_process.execSync(`cmake ${cmakeFlags} .`, {
            cwd: currentDirectory,
            stdio: "inherit"
        });
        child_process.execSync(`make -j4`, {
            cwd: currentDirectory,
            stdio: "inherit"
        });
    }

    // 5.1 Package .deb
    const debFileName = `fullstacked-${versionStr}-linux-${target.arch}-${target.framework}.deb`;
    const debFilePath = path.resolve(currentDirectory, debFileName);

    child_process.execSync(`sh ./pkg.sh "${debFilePath}"`, {
        cwd: currentDirectory,
        stdio: "inherit"
    });

    if (
        !fs.existsSync(debFilePath) &&
        fs.existsSync(path.resolve(currentDirectory, "fullstacked.deb"))
    ) {
        fs.renameSync(
            path.resolve(currentDirectory, "fullstacked.deb"),
            debFilePath
        );
    }

    releaseFiles.push({
        filePath: debFilePath,
        fileName: debFileName,
        contentType: "application/vnd.debian.binary-package"
    });

    // 5.2 Package portable .tar.xz
    const stagingDir = path.resolve(currentDirectory, "out-tar");
    if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true });
    }
    fs.mkdirSync(path.resolve(stagingDir, "fullstacked"), { recursive: true });

    fs.copyFileSync(
        path.resolve(currentDirectory, "out", "usr", "bin", "fullstacked"),
        path.resolve(stagingDir, "fullstacked", "fullstacked")
    );
    fs.chmodSync(path.resolve(stagingDir, "fullstacked", "fullstacked"), 0o755);

    fs.cpSync(
        path.resolve(
            currentDirectory,
            "out",
            "usr",
            "share",
            "fullstacked",
            "app"
        ),
        path.resolve(stagingDir, "fullstacked", "app"),
        { recursive: true }
    );

    const tarFileName = `fullstacked-${versionStr}-linux-${target.arch}-${target.framework}.tar.xz`;
    const tarFilePath = path.resolve(currentDirectory, tarFileName);

    child_process.execSync(
        `tar -cJf "${tarFilePath}" -C "${stagingDir}" fullstacked`,
        {
            cwd: currentDirectory,
            stdio: "inherit"
        }
    );

    fs.rmSync(stagingDir, { recursive: true });

    releaseFiles.push({
        filePath: tarFilePath,
        fileName: tarFileName,
        contentType: "application/x-xz"
    });
}

// 6. Upload release files to R2
async function uploadFileToR2(filePath, fileName, contentType) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const s3Key = `releases/${versionStr}/${fileName}`;

        const uploadCommand = new PutObjectCommand({
            Bucket: credentials.R2_BUCKET_NAME,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: contentType
        });

        await s3Client.send(uploadCommand);
        console.log(
            `Successfully uploaded ${fileName} (${prettyBytes(fileBuffer.byteLength)}) to R2 at key: /${s3Key}`
        );
    } catch (error) {
        console.error(`Error uploading ${fileName} to R2:`, error);
        throw new Error(`Failed to upload ${filePath}: ${error.message}`);
    }
}

console.log("\nUploading release packages to Cloudflare R2...");
for (const { filePath, fileName, contentType } of releaseFiles) {
    await uploadFileToR2(filePath, fileName, contentType);
}

// 7. Update release/beta.txt in R2
const isRelease = process.argv.includes("--release");
const versionFileKey = isRelease ? "releases/release.txt" : "releases/beta.txt";

const versionUploadCommand = new PutObjectCommand({
    Bucket: credentials.R2_BUCKET_NAME,
    Key: versionFileKey,
    Body: versionStr,
    ContentType: "text/plain"
});

await s3Client.send(versionUploadCommand);
console.log(
    `Successfully updated /${versionFileKey} with version: ${versionStr}`
);
console.log("\nLinux build and release process completed successfully!");
