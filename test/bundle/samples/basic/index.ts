import fs from "fs";

const pre = document.createElement("pre");
document.body.append(pre);
pre.innerHTML = fs.readFileSync("basic/test.md", { encoding: "utf8" });
