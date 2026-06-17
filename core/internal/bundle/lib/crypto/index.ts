import * as c from "./index.js";
export * from "./index.js";

export const crypto: any = c.default;
export const getCurves = () => [];
crypto.getCurves = getCurves;

export default crypto;
