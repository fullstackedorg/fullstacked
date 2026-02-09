//@ts-ignore
import qs from "./index.js";

export const decode = qs.parse;
export const encode = qs.stringify;

export * from "./index.js";

export default {
    decode,
    encode,
    parse: qs.parse,
    stringify: qs.stringify
};
