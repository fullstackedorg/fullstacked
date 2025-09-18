import fs from "node:fs";

const fileToPatch = "../typescript-go/internal/vfs/osvfs/os.go";

let contents = fs.readFileSync(fileToPatch, {encoding: "utf-8"});
contents = contents.replace(`if runtime.GOOS == "windows" {`, `if runtime.GOOS == "windows" || runtime.GOOS == "ios" {`);

fs.writeFileSync(fileToPatch, contents);
