import init from "./init.ts";
import { after, before } from "node:test";

before(init.before);

await import("./serialization/index.ts");
await import("./path/index.ts");
await import("./os/index.ts");
await import("./fetch/index.ts");
await import("./fs/index.ts");
await import("./stream/index.ts");
await import("./bundle/index.ts");

after(init.after);
