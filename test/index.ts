import core from "./core.ts";
import { after, before } from "node:test";

before(core.start);

// await import("./serialization/index.ts");
// await import("./path/index.ts");
// await import("./os/index.ts");
// await import("./fs/index.ts");
// await import("./static-file/index.ts");
// await import("./bundle/index.ts");
// await import("./stream/index.ts");
// await import("./fetch/index.ts");
// await import("./net/index.ts");
// await import("./dns/index.ts");
await import("./git/index.ts");

// hangs if C++ callback not released
after(core.instance.end);
