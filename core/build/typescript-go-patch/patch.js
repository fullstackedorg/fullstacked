import fs from "node:fs";

const fileToPatch = "../typescript-go/internal/project/project.go";

let contents = fs.readFileSync(fileToPatch, {encoding: "utf-8"});
contents = contents.replace(`inferredProjectName = "/dev/null/inferred"`, `inferredProjectName = ".inferred"`);

fs.writeFileSync(fileToPatch, contents);
