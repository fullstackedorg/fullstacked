import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import child_process from "node:child_process";
import esbuild from "esbuild";
import { sharedLibLocation } from "../../build.ts";

if (!fs.existsSync(sharedLibLocation)) {
    console.log("cannot find core lib binary");
    process.exit(1);
}

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

fs.cpSync(
    sharedLibLocation,
    path.resolve(currentDirectory, path.basename(sharedLibLocation))
);

const platform = os.platform();

const archArgIndex = process.argv.indexOf("--arch");
const arch =
    archArgIndex === -1 ? os.arch() : process.argv.at(archArgIndex + 1);

const target_name = platform + "-" + arch;

const binding = {
    targets: [
        {
            target_name,
            sources: ["bridge.cc", platform === "win32" ? "win.cc" : "unix.cc"],
            include_dirs: [
                "<!@(node -p \"require('node-addon-api').include\")"
            ],
            defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"]
        }
    ]
};

const bindingFilePath = path.resolve(currentDirectory, "gyp", "binding.gyp");
fs.writeFileSync(bindingFilePath, JSON.stringify(binding, null, 4));

child_process.execSync(
    `npx node-gyp --directory=${path.resolve(currentDirectory, "gyp")} --arch=${arch} clean configure build`,
    {
        cwd: currentDirectory,
        stdio: "inherit"
    }
);

fs.cpSync(
    path.resolve(
        currentDirectory,
        "gyp",
        "build",
        "Release",
        target_name + ".node"
    ),
    path.resolve(currentDirectory, target_name + ".node")
);

esbuild.buildSync({
    entryPoints: [`${currentDirectory}/src/index.ts`],
    outfile: `${currentDirectory}/index.js`,
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node"
});
