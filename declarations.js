import fs from "node:fs";
import child_process from "node:child_process";
import path from "node:path";
import prettier from "prettier";

const declarationsDir = "declarations";
const fullstackedModulesDir = "fullstacked_modules";
const typesDirectory = "@types";

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

const declaredModules = ["archive", "connect", "fs", "fetch", "platform"];

const generationPromises = declaredModules.map(async (m) => {
    const declarationFile = path.resolve(
        declarationsDir,
        fullstackedModulesDir,
        `${m}.d.ts`
    );
    const declaration = fs.readFileSync(declarationFile, { encoding: "utf-8" });
    const moduleDeclaration = `declare module "${m}" { 
    ${declaration} 
    }`;
    const typeDirectory = path.resolve(outTypesDirectory, m);
    fs.mkdirSync(typeDirectory, { recursive: true });
    const moduleDeclarationFile = path.resolve(typeDirectory, "index.d.ts");
    const formatted = await prettier.format(moduleDeclaration, {
        filepath: moduleDeclarationFile,
        tabWidth: 4
    });
    fs.writeFileSync(moduleDeclarationFile, formatted);
});

await Promise.all(generationPromises);

fs.rmSync(declarationsDir, { recursive: true });
