import * as c from "./index.js";
export * from "./index.js";

export const crypto: any = c.default;
export const getCurves = () => ["prime256v1", "secp384r1", "secp521r1"];
crypto.getCurves = getCurves;

export default crypto;
