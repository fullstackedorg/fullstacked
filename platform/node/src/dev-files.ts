import path from "node:path";
import fs from "node:fs";
import { compilerOptions } from "../../../editor/views/project/workspace/tsconfig";

const tsConfig = {
    compilerOptions: {
        ...compilerOptions,
        paths: {
            "*": ["./.fullstacked_modules/*"]
        },
        typeRoots: ["./.fullstacked_modules", "./node_modules/@types"]
    }
};

// file://./../../../core/src/git/main.go#31
const defaultGitignore = `node_modules
.build
data
tsconfig.json
.fullstacked_modules`;

export function setupDevFiles() {
    const tsConfigFile = path.resolve(process.cwd(), "tsconfig.json");
    if (!fs.existsSync(tsConfigFile)) {
        fs.writeFileSync(tsConfigFile, JSON.stringify(tsConfig, null, 4));
    }
    const gitignoreFile = path.resolve(process.cwd(), ".gitignore");
    if (!fs.existsSync(gitignoreFile)) {
        fs.writeFileSync(gitignoreFile, defaultGitignore);
    }
}
