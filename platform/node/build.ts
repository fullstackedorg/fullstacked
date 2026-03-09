import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import child_process from "node:child_process";
import esbuild from "esbuild";
import {
    arch,
    binBasename,
    bindingBasename,
    binExtension,
    binLocation,
    environment,
    fullVersion,
    platform
} from "./utils.ts";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));

if (fs.existsSync(binLocation)) {
    fs.rmSync(binLocation, { recursive: true });
}
fs.mkdirSync(binLocation, { recursive: true });

const sharedLibLocation = path.resolve(
    currentDirectory,
    "../../",
    "core",
    "bin",
    `${environment}.${binExtension}`
);

if (!fs.existsSync(sharedLibLocation)) {
    console.log("cannot find core lib binary");
    process.exit(1);
}

fs.cpSync(sharedLibLocation, path.resolve(binLocation, binBasename));

const binding = {
    targets: [
        {
            target_name: bindingBasename.slice(0, -".node".length),
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

fs.renameSync(
    path.resolve(currentDirectory, "gyp", "build", "Release", bindingBasename),
    path.resolve(binLocation, bindingBasename)
);

esbuild.buildSync({
    entryPoints: [`${currentDirectory}/src/index.ts`],
    outfile: `${currentDirectory}/index.js`,
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node"
});

const packageJsonFile = path.resolve(currentDirectory, "package.json");
const packageJson = JSON.parse(
    fs.readFileSync(packageJsonFile, { encoding: "utf-8" })
);
packageJson.version = fullVersion;
fs.writeFileSync(packageJsonFile, JSON.stringify(packageJson, null, 4));

const binPackageJson = {
    name: `@fullstacked/${environment}`,
    version: fullVersion,
    os: [platform],
    cpu: [arch]
};
fs.writeFileSync(
    path.resolve(binLocation, "package.json"),
    JSON.stringify(binPackageJson, null, 4)
);
