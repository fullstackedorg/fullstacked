// run by test/dompurify with fullstacked --file: the results go to the
// file named by the first argument
import fs from "fs";
import process from "process";
import { COMMON, PAYLOADS, sanitizeAll } from "../corpus.ts";
import { purifyWithoutWindow } from "./purify.ts";

const purify = purifyWithoutWindow();
fs.writeFileSync(
    process.argv.at(-1),
    JSON.stringify({
        supported: purify.isSupported,
        results: sanitizeAll(purify, [...COMMON, ...PAYLOADS])
    })
);
