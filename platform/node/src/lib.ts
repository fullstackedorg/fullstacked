import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import zlib from "node:zlib";
import cliProgress from "cli-progress";
import prettyBytes from "pretty-bytes";
import tar from "tar-stream";

const platform = os.platform();
const arch = os.arch();
const libBinary =
    platform + "-" + arch + "." + (platform === "win32" ? "dll" : "so");

export function getLocalLibPath(directory: string) {
    const libPath = path.resolve(directory, libBinary);
    return fs.existsSync(libPath) ? libPath : null;
}

export async function getLibPath(directory: string) {
    const libPath = getLocalLibPath(directory);
    if (libPath) return libPath;

    const packageJsonFilePath = path.resolve(directory, "package.json");
    const packageJson = JSON.parse(
        fs.readFileSync(packageJsonFilePath, { encoding: "utf8" })
    );
    const [version] = packageJson.version.split("-");
    const fileName = `${platform}-${arch}-${packageJson.version}.tgz`;
    const remoteLibUrl = `https://files.fullstacked.org/lib/${platform}/${arch}/${version}/${fileName}`;

    const response = await fetch(remoteLibUrl);
    if (!response.ok) {
        throw `Could not find FullStacked library in remote storage at [${remoteLibUrl}]`;
    }

    const size = parseInt(response.headers.get("content-length"));

    const downloadProgress = new cliProgress.SingleBar(
        {
            formatValue: (v, _, type) => {
                if (type === "total" || type === "value") {
                    return prettyBytes(v);
                }
                return v.toString();
            }
        },
        cliProgress.Presets.shades_classic
    );
    downloadProgress.start(size, 0);

    let downloaded = 0;
    const reader = response.body.getReader();
    const outPath = path.resolve(directory, fileName);
    const writeStream = fs.createWriteStream(outPath, "binary");
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        writeStream.write(value);
        downloaded += value.byteLength;
        downloadProgress.update(downloaded);
    }

    downloadProgress.stop();
    await new Promise((res) => writeStream.close(res));

    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
        const filePath = path.resolve(directory, header.name);
        const writeStream = fs.createWriteStream(filePath);
        stream.pipe(writeStream);
        writeStream.on("close", next);
    });
    const readStream = fs.createReadStream(outPath);
    const gunzip = zlib.createGunzip();

    await new Promise((res) => {
        readStream.pipe(gunzip).pipe(extract).on("close", res);
    });

    fs.rmSync(outPath);

    return libPath;
}
