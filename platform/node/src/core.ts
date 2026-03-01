import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import cliProgress from "cli-progress";
import prettyBytes from "pretty-bytes";
import tar from "tar-stream";

globalThis.require = createRequire(import.meta.url);

export interface Core {
    load(libPath: string): void;
    start(root: string, build: string): number;
    stop(ctx: number): void;
    call(payload: ArrayBuffer): ArrayBuffer;
    setOnStreamData(
        cb: (ctx: number, streamId: number, buffer: ArrayBuffer) => void
    ): void;
    end(): void;
}

let core: Core;

const platform = os.platform();
const arch = os.arch();
const libBinary = `${platform}-${arch}.${platform === "win32" ? "dll" : "so"}`;
const binding = `${platform}-${arch}.node`;

export async function load(
    libDirectory: string,
    bindingDir: string,
    onStreamData: Parameters<(typeof core)["setOnStreamData"]>[0],
    downloadLibIfNotExising = false
) {
    const libPath = path.resolve(libDirectory, libBinary);
    if (!fs.existsSync(libPath)) {
        if (downloadLibIfNotExising) {
            await downloadBinaries(libDirectory);
        } else {
            throw `Cannot find core library at ${libPath}`;
        }
    }
    const bindingPath = path.resolve(bindingDir, binding);
    if (!fs.existsSync(bindingPath)) {
        throw `Cannot find core library binding file at ${bindingPath}`;
    }
    core = require(bindingPath);
    core.load(libPath);
    core.setOnStreamData(onStreamData);
    return core;
}

export async function downloadBinaries(directory: string) {
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
        if(header.name.indexOf('..') == -1) {
            const filePath = path.resolve(directory, header.name);
            const writeStream = fs.createWriteStream(filePath);
            stream.pipe(writeStream);
            writeStream.on("close", next);
        }
        else {
            console.log('skipping bad path', fileName);
            next();
        }
    });
    const readStream = fs.createReadStream(outPath);
    const gunzip = zlib.createGunzip();

    await new Promise((res) => {
        readStream.pipe(gunzip).pipe(extract).on("close", res);
    });

    fs.rmSync(outPath);
}
