import path from "node:path";
import fs from "node:fs";

// file://./../../../editor/typescript/worker.ts#51
const defaultTsConfig = {
    compilerOptions: {
        esModuleInterop: true,
        module: "ES2022",
        target: "ES2022",
        moduleResolution: "Node10",
        allowJs: true,
        lib: ["dom", "dom.iterable", "es2023"],
        jsx: "react",
        paths: {
            "*": ["./node_modules/fullstacked/fullstacked_modules/*"]
        },
        typeRoots: [
            "./node_modules/fullstacked/fullstacked_modules",
            "./node_modules/@types"
        ]
    }
};

// file://./../../../core/src/git/main.go#31
const defaultGitignore = `node_modules
.build
data`;

export function setupDevFiles() {
    const tsConfigFile = path.resolve(process.cwd(), "tsconfig.json");
    if (!fs.existsSync(tsConfigFile)) {
        fs.writeFileSync(
            tsConfigFile,
            JSON.stringify(defaultTsConfig, null, 4)
        );
    }
    const gitignoreFile = path.resolve(process.cwd(), ".gitignore");
    if (!fs.existsSync(gitignoreFile)) {
        fs.writeFileSync(gitignoreFile, defaultGitignore);
    }
}
