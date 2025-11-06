import fs from "node:fs";
import child_process from "node:child_process";
import path from "node:path";
import prettier from "prettier";

const declarationsDir = "declarations";
const fullstackedModulesDir = "fullstacked_modules";
const typesDirectory = "@types";

// csstype

const typeFile = path.resolve("node_modules", "csstype", "index.d.ts");
const declaredModule = await makeDeclaredModule("csstype", typeFile);
const directory = path.resolve(
    fullstackedModulesDir,
    typesDirectory,
    "csstype"
);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.resolve(directory, "index.d.ts"), declaredModule);

// end csstype

if (fs.existsSync(declarationsDir)) {
    fs.rmSync(declarationsDir, { recursive: true });
}

child_process.execSync("npx tsc --project tsconfig.declarations.json", {
    stdio: "inherit"
});

const outTypesDirectory = path.resolve(fullstackedModulesDir, typesDirectory);

if (fs.existsSync(outTypesDirectory)) {
    fs.rmSync(outTypesDirectory, { recursive: true });
}

const declaredModules = [
    "archive",
    "connect",
    "fs",
    "fetch",
    "platform",
    "style"
];

function makeDeclaredModule(moduleName, filePath) {
    const contents = fs.readFileSync(filePath, { encoding: "utf-8" });
    const moduleDeclaration = `declare module "${moduleName}" { 
    ${contents} 
    }`;
    return prettier.format(moduleDeclaration, {
        filepath: filePath,
        tabWidth: 4
    });
}

const generationPromises = declaredModules.map(async (m) => {
    const declarationFile = path.resolve(
        declarationsDir,
        fullstackedModulesDir,
        `${m}.d.ts`
    );
    const moduleDeclaration = await makeDeclaredModule(m, declarationFile);
    const typeDirectory = path.resolve(outTypesDirectory, m);
    fs.mkdirSync(typeDirectory, { recursive: true });
    const moduleDeclarationFile = path.resolve(typeDirectory, "index.d.ts");

    fs.writeFileSync(moduleDeclarationFile, moduleDeclaration);
});

await Promise.all(generationPromises);

fs.rmSync(declarationsDir, { recursive: true });

