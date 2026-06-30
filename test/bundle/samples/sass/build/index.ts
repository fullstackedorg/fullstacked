// @ts-ignore
import bundle from "bundle";
// @ts-ignore
import plugin from "plugin";
import pluginSass from "../../../../../plugins/sass";

await plugin.register("build", pluginSass);

console.log(await bundle.bundle("./project"));

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "./project/out/style.scss.css";
document.head.appendChild(link);

const projectEntry = "./project/out/index.ts.js?v=2";
await import(projectEntry);
