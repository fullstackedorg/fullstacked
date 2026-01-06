import fs from "fs";

const pre = document.createElement("pre");
document.body.append(pre);
pre.innerHTML = await fs.promises.readFile("basic/test.md", {
    encoding: "utf8"
});
