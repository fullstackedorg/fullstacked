import fs from "fs";

const pre = document.createElement("pre");
pre.innerHTML = await fs.promises.readFile("test.md", {
    encoding: "utf8"
});
document.body.append(pre);
