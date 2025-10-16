import fs from "node:fs";

// /dev/null/infered crashes everything
const fileToPatch = "../typescript-go/internal/project/project.go";
let contents = fs.readFileSync(fileToPatch, { encoding: "utf8" });
contents = contents.replace(`inferredProjectName = "/dev/null/inferred"`, `inferredProjectName = ".inferred"`);
fs.writeFileSync(fileToPatch, contents);

// prevent any command.exec
const fileToPatch2 = "../typescript-go/internal/lsp/server.go";
contents = fs.readFileSync(fileToPatch2, { encoding: "utf8" });
contents = contents.replace(/NpmInstall.*{\s*\n/, (value) => value.trim() + `return nil, nil\n`);
fs.writeFileSync(fileToPatch2, contents);

// put tsgo module into the codebase
const sourceFile = "./typescript-go-patch/module/tsgo.go"
const outDir = "../typescript-go/cmd/module"
const outFile = outDir + "/tsgo.go";

fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(sourceFile, outFile);