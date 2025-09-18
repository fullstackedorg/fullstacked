import fs from "node:fs";

const fileToPatch = "../typescript-go/internal/project/project.go";

let contents = fs.readFileSync(fileToPatch, { encoding: "utf-8" });
contents = contents.replace(`inferredProjectName = "/dev/null/inferred"`, `inferredProjectName = ".inferred"`);

fs.writeFileSync(fileToPatch, contents);

const sourceFile = "./typescript-go-patch/module/tsgo.go"
const outDir = "../typescript-go/cmd/module"
const outFile = outDir + "/tsgo.go";

fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(sourceFile, outFile);