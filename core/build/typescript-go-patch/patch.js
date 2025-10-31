import fs from "node:fs";

// /dev/null/infered crashes everything
const fileToPatch = "../typescript-go/internal/project/project.go";
let contents = fs.readFileSync(fileToPatch, { encoding: "utf8" });
contents = contents.replace(
    `inferredProjectName = "/dev/null/inferred"`,
    `inferredProjectName = ".inferred"`
);
fs.writeFileSync(fileToPatch, contents);

// fix invalid utf8 panic
const fileToPatch2 = "../typescript-go/internal/ls/signaturehelp.go";
let contents2 = fs.readFileSync(fileToPatch2, { encoding: "utf8" });
contents2 = contents2
    .replace(
        `Label:         displayParts.String(),`,
        `Label:         strings.ToValidUTF8(displayParts.String(), ""),`
    )
    .replace(
        `Label:         display.String(),`,
        `Label:         strings.ToValidUTF8(display.String(), ""),`
    );
fs.writeFileSync(fileToPatch2, contents2);

// put tsgo module into the codebase
const sourceFile = "./typescript-go-patch/module/tsgo.go";
const outDir = "../typescript-go/cmd/module";
const outFile = outDir + "/tsgo.go";

fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(sourceFile, outFile);
