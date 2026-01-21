import fs from "fs";

const pre = document.createElement("pre");
document.body.append(pre);
console.log("ici");
pre.innerHTML = await fs.promises.readFile("basic/test.md", {
    encoding: "utf8"
});
console.log("puis ici");
