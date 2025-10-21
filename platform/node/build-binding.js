import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import child_process from "node:child_process";

export function buildNodeBinding(directory) {
    const platform = os.platform();

    const archArgIndex = process.argv.indexOf("--arch");
    const arch =
        archArgIndex === -1 ? os.arch() : process.argv.at(archArgIndex + 1);

    const target_name = platform + "-" + arch;

    const binding = {
        targets: [
            {
                target_name,
                sources: [
                    "bridge.cc",
                    platform === "win32" ? "win.cc" : "unix.cc"
                ],
                include_dirs: [
                    "<!@(node -p \"require('node-addon-api').include\")"
                ],
                defines: ["NAPI_DISABLE_CPP_EXCEPTIONS"]
            }
        ]
    };

    const bindingFilePath = path.resolve(directory, "gyp", "binding.gyp");
    fs.writeFileSync(bindingFilePath, JSON.stringify(binding, null, 4));

    child_process.execSync(`node-gyp --arch=${arch} clean configure build`, {
        cwd: path.resolve(directory, "gyp"),
        stdio: "inherit"
    });

    fs.cpSync(
        path.resolve(
            directory,
            "gyp",
            "build",
            "Release",
            target_name + ".node"
        ),
        path.resolve(directory, target_name + ".node")
    );
}
