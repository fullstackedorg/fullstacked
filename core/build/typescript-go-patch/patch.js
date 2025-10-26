import fs from "node:fs";

// /dev/null/infered crashes everything
const fileToPatch = "../typescript-go/internal/project/project.go";
let contents = fs.readFileSync(fileToPatch, { encoding: "utf8" });
contents = contents.replace(
    `inferredProjectName = "/dev/null/inferred"`,
    `inferredProjectName = ".inferred"`
);
fs.writeFileSync(fileToPatch, contents);

// put tsgo module into the codebase
const sourceFile = "./typescript-go-patch/module/tsgo.go";
const outDir = "../typescript-go/cmd/module";
const outFile = outDir + "/tsgo.go";

fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(sourceFile, outFile);
