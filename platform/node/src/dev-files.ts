import path from "node:path";
import fs from "node:fs";
import { compilerOptions } from "./tsconfig";

const tsConfig = {
    compilerOptions: {
        ...compilerOptions,
        typeRoots: [
            "./node_modules/fullstacked/fullstacked_modules/@types",
            "./node_modules/@types"
        ]
    }
};

// file://./../../../core/src/git/main.go#31
const defaultGitignore = `node_modules
.build
data
tsconfig.json`;

export function setupDevFiles() {
    const tsConfigFile = path.resolve(process.cwd(), "tsconfig.json");
    if (!fs.existsSync(tsConfigFile)) {
        fs.writeFileSync(tsConfigFile, JSON.stringify(tsConfig, null, 4));
    }
    const gitignoreFile = path.resolve(process.cwd(), ".gitignore");
    if (!fs.existsSync(gitignoreFile)) {
        fs.writeFileSync(gitignoreFile, defaultGitignore);
    }
    const packageJSONFilePath = path.resolve(process.cwd(), "package.json");
    if (fs.existsSync(packageJSONFilePath)) {
        const contents = fs.readFileSync(packageJSONFilePath, {
            encoding: "utf8"
        });
        try {
            if (JSON.parse(contents).type === "commonjs") {
                console.warn(
                    '[WARNING] Switch "type" to "module" in ./package.json to prevent any unexpected errors.'
                );
            }
        } catch (e) {}
    }
}
