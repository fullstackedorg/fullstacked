import core from "./core.ts";
import { after, before } from "node:test";

globalThis.nodeFetch = fetch;

before(core.start);

await import("./serialization/index.ts");
await import("./path/index.ts");
await import("./os/index.ts");
await import("./fs/index.ts");
await import("./static-file/index.ts");
await import("./bundle/index.ts");
await import("./stream/index.ts");
await import("./fetch/index.ts");
await import("./net/index.ts");

// hangs if C++ callback not released
after(core.instance.end);
