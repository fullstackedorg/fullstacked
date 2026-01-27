import fs from "fs";

const pre = document.createElement("pre");
pre.innerHTML = await fs.promises.readFile("basic/test.md", {
    encoding: "utf8"
});
document.body.append(pre);
