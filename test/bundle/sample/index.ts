import fs from "fs";

const pre = document.createElement("pre");
document.body.append(pre);
pre.innerText = fs.readFileSync("package.json", { encoding: "utf8" });
