import "./build.ts";
import "./platform/node/build.ts";

// build process updates the version in package.json
// if already imported, the version get verified before update.
await import("./platform/node/index.ts");
